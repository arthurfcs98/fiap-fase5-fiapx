#!/usr/bin/env bash
# infra/vm/99-uninstall.sh — desfaz TUDO o que os passos 20/10/30/35/40 criaram e volta a VM ao
# estado de antes (os vizinhos e o edge-caddy continuam como estavam).
#
# Uso (root, na VM):
#   ./99-uninstall.sh          dry-run: lista o que seria removido (padrão)
#   ./99-uninstall.sh --yes    remove (APAGA os dados do FIAP X: Postgres, fila, vídeos, métricas)
#
# Ordem (cada passo é idempotente; pode rodar de novo se parar no meio):
#   1 tira os sites fiapx.caddy e frames.caddy do edge-caddy (reload, sem restart) -> o tráfego para
#   2 remove usuário fiapx-deploy, /opt/fiapx e o kubeconfig do CD
#   3 k3s-uninstall.sh (para pods, apaga cni0 e regras KUBE-/CNI-/flannel, dados e binário;
#      o Traefik e o KEDA vão junto) segurando o lock do deploy dos vizinhos (NEIGHBOR_DEPLOY_LOCK
#      no infra/vm/.env), para nenhum "compose up" mexer no iptables no meio;
#      depois, os logs de pod que o k3s-uninstall.sh deixa em /var/log/pods e /var/log/containers
#   4 drop-in do systemd, discos em loop (volumes e K3s: umount, fstab, arquivo), swap criada
#      por nós, sysctl, pontos de montagem vazios; backups *.fiapx-bak.* vão para /root/fiapx-k3s
#   5 20-firewall.sh --revert (UFW da cni0, guarda raw IPv4/IPv6, sysctl de rede)
#   6 conferência contra o snapshot de antes
# Fica de propósito: route_localnet=0, snapshots e backups em /root/fiapx-k3s, o certificado de
# fiapx.asdevit.com no volume de dados do edge-caddy (a conta ACME é a mesma dos vizinhos: não
# mexemos), e o que já existia antes (/etc/rancher/node e regras de outros serviços do host). No
# fim o script lista o que só você pode apagar (a cópia dos scripts e a chave pública em /root).
set -Eeuo pipefail
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

readonly STATE_DIR=/root/fiapx-k3s
readonly LOOP_IMG=/var/lib/fiapx-k3s.img
readonly RANCHER=/var/lib/rancher
readonly PV_DIR=/var/lib/fiapx-pv              # loop dos volumes; o arquivo mora dentro de $RANCHER
readonly POD_NAMESPACES=(fiapx traefik keda kube-system)   # os que o K3s criou nesta VM
readonly DROPIN_DIR=/etc/systemd/system/k3s.service.d
readonly FSTAB_TAG="# fiapx-k3s"
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
YES=(); (( APPLY )) && YES=(--yes)

step()  { printf '\n==> %s\n' "$*"; }
info()  { printf '    %s\n' "$*"; }
done_() { printf '    [já feito] %s\n' "$*"; }
die()   { printf '\nERRO: %s\n' "$*" >&2; exit 1; }
matches() { grep "$@" >/dev/null; }  # = grep -q, mas lê a entrada toda: sem EPIPE no produtor sob pipefail
run() {
  if (( APPLY )); then printf '    $ %s\n' "$*"; "$@"
  else printf '    [dry-run] $ %s\n' "$*"; fi
}
docker_rules() { iptables-save | grep -E 'DOCKER|br-' | grep -vE 'KUBE-|CNI-|FLANNEL|fiapx-guard' | sed 's/\[[0-9:]*\]//' | sort; }

[[ $EUID -eq 0 ]] || die "rode como root"
if (( APPLY )); then
  echo "Isto APAGA o K3s e todos os dados do FIAP X nesta VM. Os vizinhos não são tocados."
  [[ -n $NEIGHBOR_DEPLOY_LOCK ]] || die "NEIGHBOR_DEPLOY_LOCK vazio (use 'nenhum' se os vizinhos não têm deploy automático): $(site_env_hint)"
  read -r -p "Digite 'desinstalar' para confirmar: " ans
  [[ $ans == desinstalar ]] || die "cancelado"
else
  echo "(dry-run: nada será alterado; use --yes para desinstalar)"
fi

# ------------------------------------------------------------------ 1. borda
step "1. Sites do FIAP X no edge-caddy (fiapx.asdevit.com e frames.asdevit.com)"
"$SCRIPT_DIR/30-ingress.sh" --revert --caddy "${YES[@]}" | sed 's/^/  /'

# ------------------------------------------------------------------ 2. acesso do CD
step "2. Usuário fiapx-deploy, /opt/fiapx e kubeconfig do CD"
"$SCRIPT_DIR/40-deployer-access.sh" --revert "${YES[@]}" | sed 's/^/  /'

# ------------------------------------------------------------------ 3. K3s
step "3. K3s (k3s-uninstall.sh)"
BEFORE=$STATE_DIR/docker-rules-antes-do-uninstall.txt
if [[ -x /usr/local/bin/k3s-uninstall.sh ]]; then
  info "O k3s-uninstall.sh faz 'iptables-save | grep -v KUBE-/CNI-/flannel | iptables-restore': reescreve"
  info "a tabela inteira. Se o Docker mudar uma regra nesse instante, a mudança se perde. Por isso"
  info "seguramos o lock do deploy dos vizinhos (o timer deles pula a rodada) durante o passo."
  if (( APPLY )); then
    install -d -m 0700 "$STATE_DIR"
    neighbor_lock_acquire
    docker_rules > "$BEFORE"
    /usr/local/bin/k3s-uninstall.sh 2>&1 | tail -n 20 | sed 's/^/    /'
    if diff "$BEFORE" <(docker_rules) >/dev/null; then info "regras do Docker intactas durante o uninstall"
    else
      info "ATENÇÃO: regras do Docker mudaram durante o uninstall:"; diff "$BEFORE" <(docker_rules) | sed 's/^/      /' || true
      info "Recrie as regras de um container com 'docker restart <nome>' (evite reiniciar o dockerd)."
    fi
    neighbor_lock_release
  else
    printf '    [dry-run] $ flock -w 600 %s   (segura o deploy dos vizinhos)\n' "${NEIGHBOR_DEPLOY_LOCK:-<NEIGHBOR_DEPLOY_LOCK>}"
    printf '    [dry-run] $ /usr/local/bin/k3s-uninstall.sh\n'
  fi
else done_ "k3s-uninstall.sh não existe (K3s já removido)"; fi

step "3b. Logs de pod que o k3s-uninstall.sh não apaga"
info "Só diretórios dos namespaces ${POD_NAMESPACES[*]} criados DEPOIS do snapshot de antes"
info "(nada de antes da instalação é tocado), e os links de /var/log/containers que ficaram órfãos."
logdirs=()
if [[ -d /var/log/pods && -d $STATE_DIR/snapshot-antes ]]; then
  for ns in "${POD_NAMESPACES[@]}"; do
    while IFS= read -r d; do logdirs+=("$d"); done \
      < <(find /var/log/pods -mindepth 1 -maxdepth 1 -type d -name "${ns}_*" -newer "$STATE_DIR/snapshot-antes" 2>/dev/null)
  done
elif [[ -d /var/log/pods ]]; then
  info "AVISO: sem $STATE_DIR/snapshot-antes para comparar datas; não apago nada em /var/log/pods"
fi
if (( ${#logdirs[@]} )); then
  for d in "${logdirs[@]}"; do run rm -rf -- "$d"; done
else done_ "nenhum log de pod do fiapx/K3s em /var/log/pods"; fi
if [[ -d /var/log/containers ]]; then
  for ns in "${POD_NAMESPACES[@]}"; do
    if (( APPLY )); then   # -xtype l = link quebrado (o diretório de destino acabou de sair)
      find /var/log/containers -maxdepth 1 -xtype l -name "*_${ns}_*.log" -print -delete | sed 's/^/    removido /'
    else
      n=$(find /var/log/containers -maxdepth 1 -type l -name "*_${ns}_*.log" 2>/dev/null | wc -l)
      printf '    [dry-run] remover os links de /var/log/containers/*_%s_*.log que ficarem órfãos (%d links hoje)\n' "$ns" "$n"
    fi
  done
fi

# ------------------------------------------------------------------ 4. host
step "4. Drop-in do systemd, discos em loop, swap e sysctl"
if [[ -d $DROPIN_DIR ]]; then run rm -rf -- "$DROPIN_DIR"; else done_ "$DROPIN_DIR não existe"; fi
# O loop dos volumes mora DENTRO do loop do K3s: desmonta primeiro (senão o umount do K3s falha).
# Depois de cada umount, solta o /dev/loopN se o autoclear ainda não soltou: loop preso segura o
# arquivo (o "target is busy" do umount de fora) e o espaço no "/" só volta depois do detach.
detach_loops() {  # detach_loops <arquivo>
  local dev
  for dev in $(losetup -j "$1" 2>/dev/null | cut -d: -f1); do run losetup -d "$dev"; done
}
if findmnt -rn "$PV_DIR" >/dev/null 2>&1; then run umount "$PV_DIR"; else done_ "$PV_DIR não está montado"; fi
if [[ -e $RANCHER/fiapx-pv.img ]]; then (( APPLY )) && sleep 1; detach_loops "$RANCHER/fiapx-pv.img"; fi
if findmnt -rn "$RANCHER" >/dev/null 2>&1; then run umount "$RANCHER"; else done_ "$RANCHER não está montado"; fi
if [[ -e $LOOP_IMG ]]; then (( APPLY )) && sleep 1; detach_loops "$LOOP_IMG"; fi
if grep -qF -- "$FSTAB_TAG" /etc/fstab; then
  if (( APPLY )); then
    cp -a /etc/fstab "/etc/fstab.fiapx-bak.$(date +%Y%m%d%H%M%S)"
    grep -vF -- "$FSTAB_TAG" /etc/fstab > /etc/fstab.fiapx-new && cat /etc/fstab.fiapx-new > /etc/fstab && rm -f /etc/fstab.fiapx-new
    info "linhas '$FSTAB_TAG' removidas do /etc/fstab (backup ao lado)"
  else
    printf '    [dry-run] remover do /etc/fstab:\n'; grep -F -- "$FSTAB_TAG" /etc/fstab | sed 's/^/        /'
  fi
else done_ "nenhuma linha fiapx no /etc/fstab"; fi
if [[ -e $LOOP_IMG ]]; then run rm -f -- "$LOOP_IMG"; else done_ "$LOOP_IMG não existe"; fi
if swapon --noheadings --show=NAME 2>/dev/null | matches -x /swapfile && grep -q '^/swapfile ' "$STATE_DIR/snapshot-antes/fstab" 2>/dev/null; then
  info "/swapfile já existia antes do fiapx: fica"
elif swapon --noheadings --show=NAME 2>/dev/null | matches -x /swapfile; then
  run swapoff /swapfile; run rm -f /swapfile
else done_ "sem /swapfile do fiapx"; fi
if [[ -f /etc/sysctl.d/90-fiapx-k3s.conf ]]; then run rm -f /etc/sysctl.d/90-fiapx-k3s.conf; else done_ "sysctl do K3s não existe"; fi
info "Valores de inotify/swappiness em memória voltam ao padrão no próximo reboot (são só limites maiores)."
run systemctl daemon-reload
left=$(find "$RANCHER" -mindepth 1 -maxdepth 1 -printf '%f ' 2>/dev/null || true)
if [[ -n $left ]]; then info "conteúdo em $RANCHER (não apago): $left"; fi
# Pontos de montagem vazios: /var/lib/rancher e /var/lib/fiapx-pv só servem ao K3s. Os de log
# (/var/log/pods, /var/log/containers) só saem se o snapshot de antes diz que não existiam.
existed=$STATE_DIR/snapshot-antes/dirs-existentes.txt
if (( APPLY )); then
  for d in "$PV_DIR" "$RANCHER" /var/log/pods /var/log/containers; do
    [[ -d $d && -z $(ls -A "$d" 2>/dev/null) ]] || continue
    if [[ $d == /var/log/* ]] && { [[ ! -f $existed ]] || matches -xF -- "$d" "$existed"; }; then
      info "$d vazio: fica (existia antes, ou não há registro em $existed)"; continue
    fi
    run rmdir -- "$d"
  done
else
  printf '    [dry-run] rmdir %s e %s se ficarem vazios; /var/log/pods e /var/log/containers só se não existiam antes\n' "$PV_DIR" "$RANCHER"
fi
# Backups que os scripts deixaram ao lado dos arquivos (put_file/fstab_add): vão para o STATE_DIR.
mapfile -t baks < <(find /etc /usr/local/sbin -maxdepth 4 -name '*.fiapx-bak.*' 2>/dev/null)
if (( ${#baks[@]} )); then
  run install -d -m 0700 "$STATE_DIR/backups"
  for b in "${baks[@]}"; do run mv -- "$b" "$STATE_DIR/backups/$(tr / _ <<<"${b#/}")"; done
else done_ "nenhum *.fiapx-bak.* em /etc ou /usr/local/sbin"; fi

# ------------------------------------------------------------------ 5. firewall
step "5. Firewall (20-firewall.sh --revert)"
"$SCRIPT_DIR/20-firewall.sh" --revert "${YES[@]}" | sed 's/^/  /'

# ------------------------------------------------------------------ 6. conferência
step "6. Conferência"
n=$(iptables-save | grep -cE 'KUBE-|FLANNEL|CNI-|fiapx-guard' || true)
info "regras KUBE-/FLANNEL/CNI-/fiapx-guard restantes: $n (esperado 0 depois do --yes)"
if ip link show cni0 >/dev/null 2>&1; then info "cni0 ainda existe"; else info "cni0 não existe: ok"; fi
info "vizinhos pela borda: $(neighbor_sites_check || true)"
if [[ -f $STATE_DIR/snapshot-antes/listeners.txt ]]; then
  info "listeners (diff contra o snapshot de antes; vazio = igual):"
  diff <(awk '{print $1, $5}' "$STATE_DIR/snapshot-antes/listeners.txt" | sort -u) <(ss -Hlntup | awk '{print $1, $5}' | sort -u) | sed 's/^/      /' || true
  info "UFW (diff contra o snapshot; vazio = igual):"
  diff "$STATE_DIR/snapshot-antes/ufw-added.txt" <(ufw show added) | sed 's/^/      /' || true
fi
cat <<EOF

Na VM, só você (o script roda de dentro desta pasta e não apaga a si mesmo):
  - rm -rf $SCRIPT_DIR /root/fiapx_deploy.pub
  - Snapshots, instalador e backups ficam em $STATE_DIR (apague quando quiser).
  - Certificados de fiapx.asdevit.com e frames.asdevit.com no volume de dados do edge-caddy: ficam
    (expiram sozinhos em até 90 dias). A conta ACME é compartilhada com os vizinhos: NÃO apague a
    pasta acme/. Se quiser tirar só os certificados:
      docker exec edge-caddy sh -c 'rm -rf /data/caddy/certificates/*/fiapx.asdevit.com /data/caddy/certificates/*/frames.asdevit.com'
Fora da VM (manual):
  - Cloudflare: apague os registros DNS "fiapx" e "frames" e a Configuration Rule "SSL Full
    (strict)" deles (ou deixe: sem origem eles dão erro 5xx).
  - GitHub: environment "production" (secrets VM_*), pacotes GHCR fiapx-* se não forem mais usados.
  - No Mac: ./00-preflight.sh --outside  (vizinhos OK; 6443/10250/10256/30080 fechadas)
EOF
(( APPLY )) || echo "(dry-run) Para desinstalar: $0 --yes"
