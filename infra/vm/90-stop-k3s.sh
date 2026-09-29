#!/usr/bin/env bash
# infra/vm/90-stop-k3s.sh — parada de emergência do K3s SEM arriscar as regras do Docker dos vizinhos.
#
# Uso (root, na VM):
#   ./90-stop-k3s.sh          dry-run: mostra o que faria (padrão)
#   ./90-stop-k3s.sh --yes    para TODOS os pods e o K3s; os dados ficam (volta: systemctl start k3s)
#
# Por que não chamar o k3s-killall.sh direto: ele termina com
#   iptables-save | grep -v KUBE-/CNI-/flannel | iptables-restore      (sem --noflush)
# que reescreve TODAS as tabelas com o que havia no instante do save. Se o deploy automático de um
# vizinho fizer um "compose up" nesse meio tempo, a regra nova do Docker (ex.: o DNAT da 443) se
# perde. Por isso: segura o lock do deploy dos vizinhos (NEIGHBOR_DEPLOY_LOCK no infra/vm/.env; o
# timer deles pula a rodada), guarda as regras do Docker, roda o killall e compara. Mesmo lock que
# o 99-uninstall.sh usa.
#
# Antes disto, o passo mais leve é tirar o site da borda: ./30-ingress.sh --revert --caddy --yes
set -Eeuo pipefail
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

readonly STATE_DIR=/root/fiapx-k3s
readonly KILLALL=/usr/local/bin/k3s-killall.sh
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR
# shellcheck source=site-env.sh
. "$SCRIPT_DIR/site-env.sh"
site_env_load "$SCRIPT_DIR"

APPLY=0
for arg in "$@"; do
  case $arg in
    --yes) APPLY=1 ;;
    -h|--help) sed -n '2,/^[^#]/{/^#/s/^# \{0,1\}//p;}' "$0"; exit 0 ;;
    *) echo "argumento desconhecido: $arg (use --help)" >&2; exit 2 ;;
  esac
done

info() { printf '    %s\n' "$*"; }
die()  { printf '\nERRO: %s\n' "$*" >&2; exit 1; }
docker_rules() { iptables-save | grep -E 'DOCKER|br-' | grep -vE 'KUBE-|CNI-|FLANNEL|fiapx-guard' | sed 's/\[[0-9:]*\]//' | sort; }
report_neighbors() { local out; out=$(neighbor_sites_check) || true; info "vizinhos pela borda: $out"; }

[[ $EUID -eq 0 ]] || die "rode como root"
[[ -x $KILLALL ]] || die "$KILLALL não existe (K3s não instalado?)"

if (( ! APPLY )); then
  echo "(dry-run: nada será alterado; use --yes)"
  info "[dry-run] \$ exec 8>>${NEIGHBOR_DEPLOY_LOCK:-<NEIGHBOR_DEPLOY_LOCK>} && flock -w 600 8   (o deploy dos vizinhos pula a rodada)"
  info "[dry-run] \$ iptables-save (linhas DOCKER/br-) > $STATE_DIR/docker-rules-antes-do-stop.txt"
  info "[dry-run] \$ $KILLALL                                         (para pods, remove KUBE-/CNI-/flannel e a cni0)"
  info "[dry-run] compara as regras do Docker, libera o lock, confere os vizinhos pela borda"
  [[ -n $NEIGHBOR_DEPLOY_LOCK ]] || info "AVISO: NEIGHBOR_DEPLOY_LOCK vazio: o --yes vai se recusar a rodar ($(site_env_hint))"
  info "Voltar depois: systemctl start k3s   (o fiapx-netguard continua ativo)"
  exit 0
fi

install -d -m 0700 "$STATE_DIR"
before=$STATE_DIR/docker-rules-antes-do-stop.txt
neighbor_lock_acquire
docker_rules > "$before"
"$KILLALL" 2>&1 | tail -n 5 | sed 's/^/    /'
if diff "$before" <(docker_rules) >/dev/null; then info "regras do Docker intactas"
else
  info "ATENÇÃO: regras do Docker mudaram durante o killall:"; diff "$before" <(docker_rules) | sed 's/^/      /' || true
  info "Recrie as regras de um container com 'docker restart <nome>' (evite reiniciar o dockerd)."
fi
neighbor_lock_release
report_neighbors
echo -e "\nK3s parado (dados preservados). Voltar: systemctl start k3s && ./00-preflight.sh --post"
