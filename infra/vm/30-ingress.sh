#!/usr/bin/env bash
# infra/vm/30-ingress.sh — entrada HTTP do cluster: Traefik (NodePort 30080) e os sites no edge-caddy.
#
# Uso (root, na VM, com o K3s no ar):
#   ./30-ingress.sh                   dry-run do Traefik (mostra o manifesto e o kubectl diff)
#   ./30-ingress.sh --yes             instala/atualiza o Traefik e confere o caminho Caddy -> NodePort
#   ./30-ingress.sh --caddy           dry-run da publicação dos sites do FIAP X no edge-caddy
#   ./30-ingress.sh --caddy --yes     valida os sites num container descartável, instala em
#                                     /opt/edge/sites/, valida de novo no edge-caddy e faz "caddy reload"
#   ./30-ingress.sh --revert [--caddy] [--yes]   desfaz (Traefik ou, com --caddy, só os sites)
#
# Sites (um arquivo por host, instalados e revertidos JUNTOS, numa troca só):
#   fiapx.caddy   fiapx.asdevit.com   host técnico: é o que o Ingress atende e o smoke do deploy usa
#   frames.caddy  frames.asdevit.com  endereço público oficial do produto (contratos.md, seção 14);
#                                     repassa ao Traefik com "Host: fiapx.asdevit.com"
#
# Por que Traefik e não ingress-nginx: o ingress-nginx foi aposentado em março/2026 e não recebe
# mais correções de segurança (README, "Decisões"). O Traefik é instalado pelo helm-controller
# que já vem no K3s (objeto HelmChart), com a versão do chart FIXADA abaixo; não precisa do
# binário helm na VM.
#
# O que NÃO muda: nada no Docker, nas portas 80/443 nem nos sites vizinhos. O Caddy só
# recebe arquivos novos e um reload (config inválida é recusada e a anterior continua valendo).
# Nenhum arquivo não validado entra em /opt/edge/sites: se o edge-caddy reiniciar no meio, ele lê
# a versão anterior ou a nova já validada. Se algo falhar depois, os arquivos ANTERIORES voltam.
# Os sites vizinhos conferidos antes/depois do reload vêm de NEIGHBOR_SITES no infra/vm/.env
# (fora do git; modelo em .env.example). Sem eles, o --caddy --yes se recusa a rodar.
set -Eeuo pipefail
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

readonly TRAEFIK_CHART_VERSION=41.6.0        # Traefik v3.7.13 (chart publicado em 2026-09-16)
readonly TRAEFIK_REPO=https://traefik.github.io/charts
readonly NODEPORT=30080
readonly BORDA_NET=borda
readonly PUBLIC_HOST=fiapx.asdevit.com       # o host que o Ingress atende
readonly SITE_FILES=(fiapx.caddy frames.caddy)
readonly SITE_HOSTS=(fiapx.asdevit.com frames.asdevit.com)
readonly EDGE=edge-caddy
readonly SITES_DIR=/opt/edge/sites
readonly CADDYFILE_HOST=/opt/edge/Caddyfile
readonly CADDYFILE_IN_CONTAINER=/etc/caddy/Caddyfile
readonly SITES_IN_CONTAINER=/etc/caddy/sites
readonly BACKUP_DIR=/root/fiapx-k3s
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR
# shellcheck source=site-env.sh
. "$SCRIPT_DIR/site-env.sh"
site_env_load "$SCRIPT_DIR"

APPLY=0 CADDY=0 REVERT=0
for arg in "$@"; do
  case $arg in
    --yes) APPLY=1 ;;
    --caddy) CADDY=1 ;;
    --revert) REVERT=1 ;;
    -h|--help) sed -n '2,/^[^#]/{/^#/s/^# \{0,1\}//p;}' "$0"; exit 0 ;;
    *) echo "argumento desconhecido: $arg (use --help)" >&2; exit 2 ;;
  esac
done

step()  { printf '\n==> %s\n' "$*"; }
info()  { printf '    %s\n' "$*"; }
done_() { printf '    [já feito] %s\n' "$*"; }
die()   { printf '\nERRO: %s\n' "$*" >&2; exit 1; }
matches() { grep "$@" >/dev/null; }  # = grep -q, mas lê a entrada toda: sem EPIPE no produtor sob pipefail
run() {
  if (( APPLY )); then printf '    $ %s\n' "$*"; "$@"
  else printf '    [dry-run] $ %s\n' "$*"; fi
}
k() { /usr/local/bin/k3s kubectl "$@"; }
http_code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$@" 2>/dev/null || true; }
edge_code() { http_code --resolve "$1:443:127.0.0.1" "https://$1${2:-/}"; }
caddy() { docker exec "$EDGE" caddy "$@" --config "$CADDYFILE_IN_CONTAINER" --adapter caddyfile; }

[[ $EUID -eq 0 ]] || die "rode como root"
BORDA_GW=$(docker network inspect "$BORDA_NET" -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)
[[ $BORDA_GW =~ ^[0-9.]+$ ]] || die "não descobri o gateway da rede docker '$BORDA_NET'"
(( APPLY )) || echo "(dry-run: nada será alterado; use --yes para aplicar)"

neighbors_ok() {  # os sites vizinhos (NEIGHBOR_SITES) continuam respondendo pela borda local?
  local out rc=0
  out=$(neighbor_sites_check) || rc=$?
  info "vizinhos pela borda local: $out"
  (( rc == 0 ))
}
require_neighbors() {  # sem a lista de vizinhos não há rede de segurança: não mexe na borda
  [[ -n ${NEIGHBOR_SITES// /} ]] && return 0
  (( APPLY )) && die "NEIGHBOR_SITES vazio: sem ele não consigo conferir que a borda segue servindo os vizinhos ($(site_env_hint))"
  info "AVISO: NEIGHBOR_SITES vazio; o --yes vai se recusar a rodar ($(site_env_hint))"
  return 1
}

# Troca atômica de um arquivo em /opt/edge/sites: grava ao lado com um nome que o
# "import sites/*.caddy" NÃO casa (.<nome>.tmp) e só então faz rename. O edge-caddy nunca vê
# arquivo pela metade.
place_site() {  # place_site <origem> <nome.caddy>
  install -o root -g root -m 0644 "$1" "$SITES_DIR/.$2.tmp"
  mv -f -- "$SITES_DIR/.$2.tmp" "$SITES_DIR/$2"
}

# Estado de antes da troca, por site: CHANGED[i]=1 se o site i vai mudar; BACKUPS[i] = cópia do
# arquivo anterior ("" se ele não existia).
CHANGED=() BACKUPS=()

# Volta ao estado de antes: cada site alterado recebe o arquivo anterior (se havia) ou sai. Reload.
restore_sites() {
  local i f
  for i in "${!SITE_FILES[@]}"; do
    (( ${CHANGED[i]:-0} )) || continue
    f=${SITE_FILES[i]}
    if [[ -n ${BACKUPS[i]:-} ]]; then place_site "${BACKUPS[i]}" "$f"; info "restaurado o $SITES_DIR/$f anterior (${BACKUPS[i]})"
    else rm -f -- "$SITES_DIR/$f"; info "removido $SITES_DIR/$f (não existia antes)"; fi
  done
  caddy reload >/dev/null 2>&1 || info "AVISO: o reload de restauração falhou; o edge-caddy segue com a config em memória"
}

# Valida a config COMPLETA (Caddyfile + sites atuais + candidatos) num container descartável, com a
# MESMA imagem do edge-caddy (sem pull, sem rede). Nada é gravado em /opt/edge/sites antes disso.
# O container recebe as MESMAS montagens (só leitura) e variáveis de ambiente do edge-caddy, com a
# pasta de sites trocada por uma cópia que já tem os candidatos: um "import" ou um {$VAR} do
# Caddyfile resolve igual ao de verdade. As variáveis vão por um arquivo 0600, apagado no fim.
validate_offline() {
  local image tmp envf rc=0 src dst f mounts=() skip=()
  image=$(docker inspect -f '{{.Image}}' "$EDGE") || return 1
  tmp=$(mktemp -d); chmod 755 "$tmp"
  envf=$(mktemp); chmod 600 "$envf"
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$EDGE" | grep -v '^$' > "$envf" || true
  install -d -m 0755 "$tmp/sites"
  for f in "${SITE_FILES[@]}"; do skip+=(! -name "$f"); done
  find "$SITES_DIR" -maxdepth 1 -type f -name '*.caddy' "${skip[@]}" -exec cp -- {} "$tmp/sites/" \;
  for f in "${SITE_FILES[@]}"; do cp -- "$SCRIPT_DIR/$f" "$tmp/sites/$f"; done
  chmod -R a+rX "$tmp"
  while IFS='|' read -r src dst; do
    [[ -n $src && -n $dst ]] || continue
    if [[ $dst == "$SITES_IN_CONTAINER" ]]; then mounts+=(-v "$tmp/sites:$dst:ro")
    else mounts+=(-v "$src:$dst:ro"); fi
  done < <(docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}|{{.Destination}}{{println}}{{end}}{{end}}' "$EDGE")
  [[ " ${mounts[*]} " == *" $tmp/sites:$SITES_IN_CONTAINER:ro "* ]] || mounts+=(-v "$tmp/sites:$SITES_IN_CONTAINER:ro")
  docker run --rm --pull=never --network none --env-file "$envf" "${mounts[@]}" \
    "$image" caddy validate --config "$CADDYFILE_IN_CONTAINER" --adapter caddyfile 2>&1 | tail -n 2 | sed 's/^/    /' || rc=$?
  rm -rf -- "$tmp" "$envf"
  return "$rc"
}

# ================================================================== sites no edge-caddy
caddy_install() {
  local i f h code n=0 stamp
  step "1. Pré-condições dos sites"
  docker inspect -f '{{.State.Running}}' "$EDGE" 2>/dev/null | matches true || die "container $EDGE não está rodando"
  for f in "${SITE_FILES[@]}"; do [[ -f $SCRIPT_DIR/$f ]] || die "não achei $SCRIPT_DIR/$f"; done
  [[ -f $CADDYFILE_HOST ]] || die "não achei $CADDYFILE_HOST"
  if require_neighbors; then
    neighbors_ok || die "algum vizinho já não responde ANTES da mudança; não mexo na borda assim"
  fi
  code=$(http_code -H "Host: $PUBLIC_HOST" "http://$BORDA_GW:$NODEPORT/")
  if [[ $code =~ ^[1-5][0-9][0-9]$ ]]; then info "Traefik responde em $BORDA_GW:$NODEPORT (HTTP $code)"
  else info "AVISO: nada responde em $BORDA_GW:$NODEPORT; os sites vão devolver 502 até o Traefik subir"; fi
  for h in "${SITE_HOSTS[@]}"; do
    info "DNS público de $h: $(getent ahostsv4 "$h" | awk '{print $1}' | sort -u | tr '\n' ' ')"
  done
  info "Cloudflare: Configuration Rule SSL Full (strict) para fiapx.asdevit.com; frames.asdevit.com"
  info "fica em Flexible até entrar na regra (README, P13). Nos dois, HTTP puro vira 308."

  step "2. O que muda"
  for i in "${!SITE_FILES[@]}"; do
    f=${SITE_FILES[i]}; CHANGED[i]=0; BACKUPS[i]=""
    if [[ -f $SITES_DIR/$f ]] && cmp -s "$SCRIPT_DIR/$f" "$SITES_DIR/$f"; then done_ "$SITES_DIR/$f igual ao do repo"
    else
      CHANGED[i]=1; n=$((n + 1))
      if [[ -f $SITES_DIR/$f ]]; then info "alterar $SITES_DIR/$f:"; diff -u "$SITES_DIR/$f" "$SCRIPT_DIR/$f" | sed 's/^/        /' || true
      else info "criar $SITES_DIR/$f"; fi
    fi
  done
  (( n )) || { info "nada a recarregar"; return 0; }

  step "3. Validar os candidatos num container descartável (mesma imagem do $EDGE, sem rede)"
  if (( APPLY )); then
    validate_offline || die "a config com os novos sites é inválida; nada foi alterado em $SITES_DIR"
  else
    printf '    [dry-run] $ docker run --rm --pull=never --network none <imagem do %s> caddy validate (Caddyfile + sites + candidatos)\n' "$EDGE"
  fi

  step "4. Instalar (backup do anterior, troca atômica)"
  stamp=$(date +%Y%m%d%H%M%S)
  run install -d -m 0700 "$BACKUP_DIR"
  for i in "${!SITE_FILES[@]}"; do
    (( CHANGED[i] )) || continue
    f=${SITE_FILES[i]}
    if [[ -f $SITES_DIR/$f ]]; then
      BACKUPS[i]=$BACKUP_DIR/$f.bak.$stamp
      run cp -a "$SITES_DIR/$f" "${BACKUPS[i]}"
    fi
    if (( APPLY )); then place_site "$SCRIPT_DIR/$f" "$f"; info "instalado $SITES_DIR/$f"
    else printf '    [dry-run] $ install -m 0644 %s %s/.%s.tmp && mv -f ... %s/%s\n' "$SCRIPT_DIR/$f" "$SITES_DIR" "$f" "$SITES_DIR" "$f"; fi
  done

  step "5. Validar no $EDGE e recarregar (sem restart)"
  if (( ! APPLY )); then
    printf '    [dry-run] $ docker exec %s caddy validate --config %s --adapter caddyfile\n' "$EDGE" "$CADDYFILE_IN_CONTAINER"
    printf '    [dry-run] $ docker exec %s caddy reload --config %s --adapter caddyfile\n' "$EDGE" "$CADDYFILE_IN_CONTAINER"
    info "[dry-run] depois: confere os vizinhos; se algum cair, volta os arquivos anteriores (ou nenhum) e recarrega"
    return 0
  fi
  if ! caddy validate 2>&1 | tail -n 2 | sed 's/^/    /'; then
    restore_sites; die "caddy validate (no $EDGE) recusou a config; estado anterior restaurado"
  fi
  if ! caddy reload 2>&1 | sed 's/^/    /'; then
    restore_sites; die "caddy reload falhou; estado anterior restaurado"
  fi
  sleep 3
  if ! neighbors_ok; then
    restore_sites
    die "algum vizinho parou de responder depois do reload: estado anterior restaurado"
  fi

  step "6. Conferência de cada host"
  for h in "${SITE_HOSTS[@]}"; do
    info "aguardando o certificado de $h (HTTP-01 via Cloudflare, até 90 s)..."
    for _ in $(seq 1 30); do
      code=$(edge_code "$h" /api/health/live)
      [[ $code != 000 ]] && break
      sleep 3
    done
    info "$h pela borda local: HTTP $code (404 = Traefik sem rota ainda; 200 = app no ar)"
    code=$(http_code -H "Host: $h" "http://127.0.0.1/api/health/live")
    if [[ $code == 308 ]]; then info "$h em HTTP puro na borda local: 308 para https:// (sem texto puro de ponta a ponta)"
    else info "AVISO: $h em HTTP puro na borda local respondeu $code (esperado 308): confira o @texto_puro"; fi
    code=$(http_code "https://$h/api/health/live")
    info "$h pela Cloudflare: HTTP $code"
    if [[ $code == 308 ]]; then info "AVISO: 308 em loop = a Cloudflare fala HTTP com a origem e o bloco http:// não está carregado"; fi
  done
}

caddy_revert() {
  local f backup stamp n=0
  step "Remover os sites do FIAP X do edge-caddy (${SITE_HOSTS[*]})"
  stamp=$(date +%Y%m%d%H%M%S)
  for f in "${SITE_FILES[@]}"; do
    if [[ ! -f $SITES_DIR/$f ]]; then done_ "$SITES_DIR/$f não existe"; continue; fi
    n=$((n + 1))
    backup=$BACKUP_DIR/$f.removido.$stamp
    run install -d -m 0700 "$BACKUP_DIR"
    run cp -a "$SITES_DIR/$f" "$backup"
    run rm -f "$SITES_DIR/$f"
    (( APPLY )) && info "cópia do site removido: $backup"
  done
  (( n )) || return 0
  if (( APPLY )); then
    caddy validate 2>&1 | tail -n 1 | sed 's/^/    /'
    caddy reload 2>&1 | sed 's/^/    /'
    sleep 2
    # Remover é o caminho de emergência: roda mesmo sem a lista de vizinhos, mas avisa.
    if [[ -z ${NEIGHBOR_SITES// /} ]]; then info "AVISO: NEIGHBOR_SITES vazio; confira os vizinhos à mão ($(site_env_hint))"
    else neighbors_ok || die "algum vizinho não responde depois do reload: investigue já (docker logs $EDGE; cópias em $BACKUP_DIR)"; fi
  else
    printf '    [dry-run] $ docker exec %s caddy validate ... && caddy reload ...\n' "$EDGE"
  fi
}

# ================================================================== Traefik
traefik_manifest() {
  cat <<EOF
# Gerado por infra/vm/30-ingress.sh. Traefik $TRAEFIK_CHART_VERSION via helm-controller do K3s.
apiVersion: v1
kind: Namespace
metadata:
  name: traefik
  labels:
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/warn: restricted
---
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: traefik
  namespace: kube-system
spec:
  repo: $TRAEFIK_REPO
  chart: traefik
  version: "$TRAEFIK_CHART_VERSION"
  targetNamespace: traefik
  valuesContent: |-
    deployment:
      replicas: 1
    # NodePort (nunca LoadBalancer: o servicelb está desligado). O kube-proxy só publica o
    # NodePort em $BORDA_GW (nodeport-addresses), que é onde o edge-caddy conecta.
    service:
      spec:
        type: NodePort
        # Cluster (não Local): com SNAT a resposta volta pela bridge da borda. Com Local, a
        # regra raw do Docker (-d <ip-do-caddy> ! -i <bridge> DROP) descartaria a resposta.
        externalTrafficPolicy: Cluster
    ports:
      web:
        nodePort: $NODEPORT
        forwardedHeaders:
          # Depois do SNAT do NodePort, o Traefik vê todo pedido vindo de 10.42.0.1 (IP da cni0).
          trustedIPs: ["10.42.0.1/32"]
        transport:
          respondingTimeouts:
            readTimeout: 600s   # o padrão do Traefik v3 (60 s) cortaria upload de ~100 MB
      websecure:
        expose:
          default: false        # TLS termina no edge-caddy
    ingressClass:
      enabled: true
      isDefaultClass: true
    ingressRoute:
      dashboard:
        enabled: false
    providers:
      kubernetesCRD:
        allowCrossNamespace: false
        allowExternalNameServices: false
      kubernetesIngress:
        allowExternalNameServices: false
    global:
      checkNewVersion: false
      sendAnonymousUsage: false
    log:
      format: json
    resources:
      requests: { cpu: 50m, memory: 64Mi }
      limits: { cpu: 500m, memory: 192Mi }
EOF
}

traefik_install() {
  step "1. Pré-condições"
  systemctl is-active --quiet k3s || die "k3s não está ativo"
  [[ $(k get --raw /readyz 2>/dev/null) == ok ]] || die "apiserver não está pronto"
  k -n kube-system get deploy traefik >/dev/null 2>&1 && die "existe o Traefik EMBUTIDO do K3s: 'traefik' precisa estar em disable no config.yaml"
  info "chart traefik $TRAEFIK_CHART_VERSION de $TRAEFIK_REPO; NodePort $NODEPORT em $BORDA_GW"

  step "2. Manifesto (Namespace traefik + HelmChart)"
  traefik_manifest | sed 's/^/        /'
  if (( APPLY )); then
    traefik_manifest | k apply --server-side --field-manager=fiapx-infra -f - | sed 's/^/    /'
  else
    info "[dry-run] kubectl diff contra o cluster:"
    traefik_manifest | k diff --server-side --field-manager=fiapx-infra -f - 2>&1 | sed 's/^/        /' || true
    return 0
  fi

  step "3. Aguardar o helm-controller e o rollout (até 5 min)"
  for _ in $(seq 1 100); do
    k -n traefik get deploy traefik >/dev/null 2>&1 && break
    sleep 3
  done
  k -n traefik get deploy traefik >/dev/null 2>&1 || { k -n kube-system logs job/helm-install-traefik --tail=40 2>&1 | sed 's/^/    /'; die "o Deployment traefik não apareceu"; }
  k -n traefik rollout status deploy/traefik --timeout=300s | sed 's/^/    /'

  step "4. Conferência do caminho edge-caddy -> $BORDA_GW:$NODEPORT -> Traefik"
  local svc code
  svc=$(k -n traefik get svc traefik -o jsonpath='{.spec.type} {.spec.ports[?(@.name=="web")].nodePort} {.spec.externalTrafficPolicy}')
  [[ $svc == "NodePort $NODEPORT Cluster" ]] || die "Service traefik inesperado: $svc"
  info "Service: $svc"
  iptables -t nat -S KUBE-NODEPORTS | matches -- "--dport $NODEPORT" || die "sem regra KUBE-NODEPORTS para $NODEPORT"
  info "kube-proxy: regra do NodePort $NODEPORT criada"
  code=$(http_code -H "Host: $PUBLIC_HOST" "http://$BORDA_GW:$NODEPORT/")
  info "host -> $BORDA_GW:$NODEPORT: HTTP $code (404 page not found = Traefik sem rota: caminho OK)"
  code=$(docker exec "$EDGE" wget -q -S -O /dev/null -T 5 --header "Host: $PUBLIC_HOST" "http://$BORDA_GW:$NODEPORT/" 2>&1 | awk '/HTTP\//{print $2; exit}')
  [[ ${code:-} =~ ^[1-5][0-9][0-9]$ ]] || die "o edge-caddy não alcança $BORDA_GW:$NODEPORT"
  info "de dentro do edge-caddy: HTTP $code (o caminho real do Caddy)"
  echo -e "\nTraefik no ar. Próximo passo: ./40-deployer-access.sh --pubkey <arquivo.pub>; depois ./30-ingress.sh --caddy"
}

traefik_revert() {
  step "Remover o Traefik"
  systemctl is-active --quiet k3s || { done_ "k3s parado/ausente: nada a remover no cluster"; return 0; }
  if k -n kube-system get helmchart traefik >/dev/null 2>&1; then
    run k -n kube-system delete helmchart traefik --wait=true --timeout=180s   # o helm-controller roda o helm uninstall
  else done_ "HelmChart traefik não existe"; fi
  if k get ns traefik >/dev/null 2>&1; then run k delete ns traefik --wait=true --timeout=180s; else done_ "namespace traefik não existe"; fi
}

if (( REVERT )); then
  if (( CADDY )); then caddy_revert; else traefik_revert; fi
elif (( CADDY )); then
  caddy_install
else
  traefik_install
fi
(( APPLY )) || echo -e "\n(dry-run) Para aplicar, repita com --yes."
