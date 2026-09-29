#!/usr/bin/env bash
# infra/vm/00-preflight.sh — checagens SOMENTE LEITURA da VM, antes e depois do K3s.
#
# Uso:
#   sudo ./00-preflight.sh             na VM, ANTES de instalar: sai com 1 se algo torna a
#                                      instalação insegura para os vizinhos/edge-caddy
#   sudo ./00-preflight.sh --post      na VM, DEPOIS dos passos 20/10/30/40: confere o resultado
#   ./00-preflight.sh --outside [IPv4] [IPv6]
#                                      no Mac (sem root): sondagens de fora (portas do K3s
#                                      fechadas em IPv4 e, se este host tiver IPv6, em IPv6;
#                                      vizinhos e fiapx pela Cloudflare; http:// vira 30x)
#
# Vizinhos (sites, containers) e IPs públicos vêm do infra/vm/.env (fora do git: o repo é
# público). Modelo: infra/vm/.env.example. Sem o .env, essas checagens viram AVISO.
#
# Nada aqui altera a máquina: só lê /proc, /sys, arquivos de config, `iptables -S`,
# `ufw status`, `docker inspect`, `ss`, e faz GETs HTTP.
# Saída: 0 = pode seguir | 1 = há FALHA (não siga) | 2 = uso inválido
# shellcheck disable=SC2015  # ok/warn/fail/info sempre retornam 0: "teste && ok || fail" é seguro
set -Euo pipefail
export LC_ALL=C

readonly K3S_VERSION=v1.36.4+k3s1
readonly BORDA_NET=borda
readonly NODEPORT=30080
readonly PUBLIC_HOST=fiapx.asdevit.com                 # host técnico (o que o Ingress atende)
readonly SITES=(fiapx.caddy:fiapx.asdevit.com frames.caddy:frames.asdevit.com)   # arquivo:host na borda
readonly STATE_DIR=/root/fiapx-k3s
readonly LOOP_IMG=/var/lib/fiapx-k3s.img
readonly PV_IMG=/var/lib/rancher/fiapx-pv.img
readonly PV_DIR=/var/lib/fiapx-pv
readonly EDGE=edge-caddy
readonly K3S_TCP_PORTS=(6443 6444 10010 10248 10249 10250 10256 10257 10259 "$NODEPORT")
readonly DEPLOY_HOME=/var/lib/fiapx-deploy
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR
# shellcheck source=site-env.sh
. "$SCRIPT_DIR/site-env.sh"
site_env_load "$SCRIPT_DIR"

FAILS=0 WARNS=0
ok()      { printf '  [ OK  ] %s\n' "$*"; }
warn()    { printf '  [AVISO] %s\n' "$*"; WARNS=$((WARNS + 1)); }
fail()    { printf '  [FALHA] %s\n' "$*"; FAILS=$((FAILS + 1)); }
info()    { printf '  [info ] %s\n' "$*"; }
section() { printf '\n== %s\n' "$*"; }
have()    { command -v "$1" >/dev/null 2>&1; }
matches() { grep "$@" >/dev/null; }  # = grep -q, mas lê a entrada toda: sem EPIPE no produtor sob pipefail

summary() {
  printf '\nResumo: %d falha(s), %d aviso(s).\n' "$FAILS" "$WARNS"
  if (( FAILS > 0 )); then
    echo "NÃO siga adiante: resolva as FALHAS acima (ou entenda por que são falso positivo)."
    exit 1
  fi
  echo "Pode seguir para o próximo passo da infra/vm/README.md."
  exit 0
}

usage() { sed -n '2,/^# shellcheck/{/^# shellcheck/d;s/^# \{0,1\}//p;}' "$0"; }

# ------------------------------------------------------------------ utilidades de leitura
borda_gw() { docker network inspect "$BORDA_NET" -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null; }
node_ip()  { ip -4 -o route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}'; }
egress_if(){ ip -4 -o route show default 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}'; }
http_code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$@" 2>/dev/null || true; }
# GET local no Caddy (127.0.0.1:443) com SNI do site, sem passar pela Cloudflare
edge_code() { http_code --resolve "$1:443:127.0.0.1" "https://$1${2:-/}"; }
listening() { ss -Hlntu 2>/dev/null | awk '{print $1, $5}'; }

check_neighbors() {
  local c st
  [[ -n ${NEIGHBOR_CONTAINERS// /} ]] || warn "NEIGHBOR_CONTAINERS vazio: não confiro os containers vizinhos ($(site_env_hint))"
  # shellcheck disable=SC2086  # lista separada por espaço
  for c in "$EDGE" $NEIGHBOR_CONTAINERS; do
    st=$(docker inspect -f '{{.State.Status}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null || echo ausente)
    case $st in
      running|running/healthy) ok "container $c: $st" ;;
      ausente) if [[ $c == "$EDGE" ]]; then fail "container $c não existe"; else warn "container $c não existe (nome mudou?)"; fi ;;
      *) if [[ $c == "$EDGE" ]]; then fail "container $c: $st"; else warn "container $c: $st"; fi ;;
    esac
  done
}

check_edge_sites() {  # os sites vizinhos respondem 2xx/3xx pela borda local?
  local out rc=0
  out=$(neighbor_sites_check) || rc=$?
  case $rc in
    0) ok "vizinhos pela borda local: $out" ;;
    2) warn "NEIGHBOR_SITES vazio: não confiro os sites vizinhos ($(site_env_hint))" ;;
    *) fail "vizinhos pela borda local: $out" ;;
  esac
}

# ================================================================== ANTES da instalação
pre_checks() {
  local gw nip avail_mib free_gib fw legacy p port hits ns

  section "Sistema"
  [[ $EUID -eq 0 ]] || { fail "rode como root (sudo -i)"; summary; }
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ $ID == ubuntu && $VERSION_ID == 24.04 ]]; then ok "$PRETTY_NAME, kernel $(uname -r)"; else warn "SO $PRETTY_NAME (o plano foi validado em Ubuntu 24.04)"; fi
  [[ $(uname -m) == x86_64 ]] && ok "arquitetura x86_64" || fail "arquitetura $(uname -m): as imagens do CD são linux/amd64"
  [[ $(stat -fc %T /sys/fs/cgroup) == cgroup2fs ]] && ok "cgroup v2" || fail "cgroup v1: reservas, OOM e eviction do plano assumem cgroup v2"
  avail_mib=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
  if (( avail_mib >= 5000 )); then ok "memória disponível: ${avail_mib} MiB"
  elif (( avail_mib >= 4000 )); then warn "memória disponível: ${avail_mib} MiB (o orçamento conta com ~6 GiB livres hoje)"
  else fail "memória disponível: ${avail_mib} MiB (< 4000): alguém está usando a VM além do esperado"; fi
  free_gib=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
  if (( free_gib >= 30 )); then ok "disco /: ${free_gib} GiB livres"
  elif (( free_gib >= 25 )); then warn "disco /: ${free_gib} GiB livres (loop de 20 GiB + folga pede >= 30)"
  else fail "disco /: ${free_gib} GiB livres (< 25): libere espaço antes (README, 'Espaço recuperável')"; fi
  if [[ -n $(swapon --noheadings 2>/dev/null) ]]; then info "swap ativa: $(swapon --noheadings --show=NAME,SIZE | tr '\n' ' ')"; else info "sem swap (decisão pendente do Arthur; ver README)"; fi
  [[ $(timedatectl show -p NTPSynchronized --value 2>/dev/null) == yes ]] && ok "relógio sincronizado (NTP)" || warn "relógio não sincronizado: tokens e TLS dependem da hora certa"

  section "Ferramentas (as que os scripts e o deploy.sh usam)"
  for p in curl git flock python3 setsid logger sha256sum findmnt losetup mkfs.ext4 blkid ufw iptables iptables-save docker ssh-keygen runuser install; do
    have "$p" || fail "falta o comando $p"
  done
  tail --version 2>/dev/null | matches GNU && ok "ferramentas presentes (GNU tail incluso)" || fail "tail não é o GNU (o deploy.sh usa tail --pid)"

  section "Vizinhos (Docker) e borda"
  docker info >/dev/null 2>&1 || { fail "docker não responde"; summary; }
  fw=$(docker info 2>/dev/null | awk -F': ' '/Firewall Backend/ {print $2; exit}')
  case $fw in
    iptables*) ok "Docker com firewall backend iptables" ;;
    "") warn "não achei 'Firewall Backend' no docker info (esperado: iptables)" ;;
    *) fail "Docker com firewall backend '$fw': o plano assume iptables (nftables no Docker quebra o convívio com o kube-proxy)" ;;
  esac
  check_neighbors
  gw=$(borda_gw)
  if [[ -n $gw ]] && ip -4 -o addr show | matches " inet $gw/"; then ok "rede $BORDA_NET: gateway $gw presente no host (onde o NodePort vai existir)"
  else fail "rede $BORDA_NET sem gateway visível no host (gw='$gw')"; fi
  [[ $gw == 172.18.0.1 ]] || warn "o gateway da borda não é 172.18.0.1: ajuste fiapx.caddy, frames.caddy e o deploy.sh (INGRESS_URL)"
  grep -q '^import sites/\*\.caddy' /opt/edge/Caddyfile 2>/dev/null && ok "Caddyfile importa sites/*.caddy" || fail "/opt/edge/Caddyfile não importa sites/*.caddy"
  docker inspect "$EDGE" -f '{{range .Mounts}}{{.Source}}={{.Destination}} {{end}}' 2>/dev/null | matches '/opt/edge/sites=/etc/caddy/sites' \
    && ok "edge-caddy monta /opt/edge/sites (arquivo novo aparece sem recriar o container)" \
    || fail "edge-caddy não monta /opt/edge/sites em /etc/caddy/sites"
  for p in fiapx.caddy frames.caddy; do
    [[ -e /opt/edge/sites/$p ]] && info "/opt/edge/sites/$p já existe" || ok "$p ainda não instalado (esperado)"
  done
  check_edge_sites

  section "K3s: instalação limpa"
  if systemctl is-active --quiet k3s 2>/dev/null; then fail "k3s já está ATIVO: use --post"; fi
  if [[ -x /usr/local/bin/k3s ]]; then warn "binário do k3s já existe: $(/usr/local/bin/k3s --version 2>/dev/null | head -1)"; else ok "k3s não instalado"; fi
  if findmnt -rn /var/lib/rancher >/dev/null 2>&1; then
    losetup -j "$LOOP_IMG" 2>/dev/null | matches . && ok "/var/lib/rancher já é o disco em loop do fiapx" || fail "/var/lib/rancher é um ponto de montagem que não é o do fiapx"
  elif [[ -n $(ls -A /var/lib/rancher 2>/dev/null) ]]; then
    fail "/var/lib/rancher não está vazio (sobra da Fase 2?): o loop seria montado por cima"
  else ok "/var/lib/rancher vazio"; fi
  if findmnt -rn "$PV_DIR" >/dev/null 2>&1; then
    losetup -j "$PV_IMG" 2>/dev/null | matches . && ok "$PV_DIR já é o disco em loop dos volumes" || fail "$PV_DIR é um ponto de montagem que não é o do fiapx"
  elif [[ -n $(ls -A "$PV_DIR" 2>/dev/null) ]]; then
    fail "$PV_DIR não está vazio: o loop dos volumes seria montado por cima"
  fi
  hits=$(iptables-save 2>/dev/null | grep -cE '^-A (KUBE-|FLANNEL|CNI-)' || true)
  (( hits == 0 )) && ok "nenhuma regra KUBE-/FLANNEL/CNI- sobrando" || fail "$hits regras KUBE-/FLANNEL/CNI- sobrando de outra instalação"
  for p in cni0 flannel.1; do ip link show "$p" >/dev/null 2>&1 && fail "interface $p já existe"; done
  [[ -e /etc/rancher/node/password ]] && info "/etc/rancher/node/password (sobra da Fase 2) existe: inofensivo, o datastore é novo"

  section "Firewall e rede"
  iptables -V 2>/dev/null | matches nf_tables && ok "$(iptables -V)" || fail "iptables não é o backend nf_tables"
  legacy=$(cat /proc/net/ip_tables_names 2>/dev/null || true)
  [[ -z $legacy ]] && ok "nenhuma tabela iptables-legacy carregada" || fail "tabelas legacy carregadas ($legacy): mistura de backends"
  if ufw status verbose 2>/dev/null | matches '^Status: active'; then ok "UFW ativo"; else fail "UFW inativo"; fi
  ufw status verbose 2>/dev/null | matches 'deny (incoming)' && ok "UFW nega entrada por padrão" || fail "UFW não nega entrada por padrão"
  if ufw status 2>/dev/null | matches -E '^(6443|10250)(/tcp)? +ALLOW +Anywhere'; then fail "há regra UFW pública para 6443/10250: remova (a API do K3s nunca fica pública)"; fi
  [[ $(iptables -S INPUT | head -1) == "-P INPUT DROP" ]] && ok "INPUT policy DROP" || fail "INPUT policy não é DROP"
  [[ $(ip6tables -S INPUT 2>/dev/null | head -1) == "-P INPUT DROP" ]] && ok "IPv6 INPUT policy DROP (6443/10250 escutam em * = IPv4 e IPv6)" || fail "IPv6 INPUT policy não é DROP: 6443/10250 ficariam expostos em IPv6"
  [[ $(iptables -S FORWARD | head -1) == "-P FORWARD DROP" ]] && ok "FORWARD policy DROP" || warn "FORWARD policy não é DROP"
  [[ $(iptables -S DOCKER-USER 2>/dev/null | wc -l) -le 1 ]] && ok "DOCKER-USER vazia" || warn "DOCKER-USER tem regras: revise (o plano não usa essa cadeia)"
  for port in "${K3S_TCP_PORTS[@]}"; do
    if listening | awk '$1=="tcp"' | matches -E ":${port}\$"; then fail "porta tcp/$port já está em uso"; fi
  done
  listening | awk '$1=="udp"' | matches -E ':8472$' && fail "porta udp/8472 (VXLAN) em uso"
  ok "portas do K3s livres (6443, 10250, 30080 ...)"
  if ip -4 route | matches -E '^10\.4[23]\.'; then fail "já existe rota para 10.42/10.43 (colide com pods/services)"; else ok "10.42.0.0/16 e 10.43.0.0/16 livres nas rotas"; fi
  for ns in $(docker network ls -q 2>/dev/null); do
    docker network inspect "$ns" -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null | grep -E ' 10\.4[23]\.' && fail "rede docker colide com 10.42/10.43"
  done
  if [[ $(sysctl -n net.ipv4.conf.all.route_localnet) == 1 ]]; then warn "route_localnet=1 (sobra da Fase 2): o 20-firewall.sh zera"; else ok "route_localnet=0"; fi
  ns=$(awk '/^nameserver [0-9.]+$/ {print $2}' /run/systemd/resolve/resolv.conf 2>/dev/null | tr '\n' ' ')
  [[ -n $ns ]] && ok "resolvers IPv4 para o CoreDNS: $ns" || fail "nenhum resolver IPv4 em /run/systemd/resolve/resolv.conf"
  nip=$(node_ip); [[ -n $nip ]] && info "node-ip: $nip (interface de saída: $(egress_if))" || fail "não consegui descobrir o IP de saída"

  section "SSH (usado pelo CD)"
  info "$(sshd -T 2>/dev/null | grep -E '^(usepam|passwordauthentication|permituserenvironment|strictmodes) ' | tr '\n' ' ')"
  systemctl is-active --quiet fail2ban && ok "fail2ban ativo" || warn "fail2ban inativo"
  id fiapx-deploy >/dev/null 2>&1 && info "usuário fiapx-deploy já existe" || ok "usuário fiapx-deploy ainda não existe (o 40 cria)"

  summary
}

# ================================================================== DEPOIS da instalação
post_checks() {
  local gw nip memtotal exp got node cfg extra rules code n
  [[ $EUID -eq 0 ]] || { fail "rode como root"; summary; }
  gw=$(borda_gw)
  k() { /usr/local/bin/k3s kubectl "$@"; }

  section "K3s"
  systemctl is-active --quiet k3s && ok "k3s ativo" || { fail "k3s inativo"; summary; }
  got=$(/usr/local/bin/k3s --version 2>/dev/null | awk 'NR==1 {print $3}')
  [[ $got == "$K3S_VERSION" ]] && ok "versão $got" || warn "versão $got (fixada: $K3S_VERSION)"
  [[ $(k get --raw /readyz 2>/dev/null) == ok ]] && ok "apiserver /readyz ok" || fail "apiserver não está pronto"
  node=$(k get nodes -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  [[ $(k get node "$node" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null) == True ]] && ok "nó $node Ready" || fail "nó $node não está Ready"
  nip=$(k get node "$node" -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null)
  info "InternalIP do nó: $nip"
  for n in coredns local-path-provisioner metrics-server; do
    [[ $(k -n kube-system get deploy "$n" -o jsonpath='{.status.readyReplicas}' 2>/dev/null) -ge 1 ]] 2>/dev/null && ok "kube-system/$n pronto" || fail "kube-system/$n não está pronto"
  done
  for n in traefik servicelb; do
    k -n kube-system get deploy "$n" >/dev/null 2>&1 && fail "kube-system/$n existe (deveria estar desabilitado)"
  done
  k -n kube-system get ds -o name 2>/dev/null | matches svclb && fail "DaemonSet svclb existe (servicelb deveria estar desabilitado)"

  section "Proteção de recursos (kubelet e cgroups)"
  memtotal=$(awk '/^MemTotal:/ {print $2 * 1024}' /proc/meminfo)
  exp=$(( memtotal - 3 * 1024 * 1024 * 1024 ))          # capacity - systemReserved(2Gi) - kubeReserved(1Gi)
  got=$(cat /sys/fs/cgroup/kubepods.slice/memory.max 2>/dev/null || echo 0)
  if [[ $got =~ ^[0-9]+$ ]] && (( got > exp - 64*1024*1024 && got < exp + 64*1024*1024 )); then ok "kubepods.slice memory.max = $((got/1024/1024)) MiB (parede dura de todos os pods)"
  else fail "kubepods.slice memory.max = $got (esperado ~$((exp/1024/1024)) MiB)"; fi
  info "kubepods.slice cpu.weight = $(cat /sys/fs/cgroup/kubepods.slice/cpu.weight 2>/dev/null) (esperado ~98; system.slice = $(cat /sys/fs/cgroup/system.slice/cpu.weight 2>/dev/null))"
  [[ $(cat /sys/fs/cgroup/system.slice/memory.max 2>/dev/null) == max ]] && ok "system.slice (vizinhos, Docker, sshd) sem limite novo" || fail "system.slice ganhou memory.max: os vizinhos ficaram limitados"
  cfg=$(k get --raw "/api/v1/nodes/$node/proxy/configz" 2>/dev/null | python3 -c '
import json,sys
c=json.load(sys.stdin)["kubeletconfig"]
print(c.get("evictionHard",{}).get("memory.available","-"), c.get("singleProcessOOMKill","-"), c.get("systemReserved",{}).get("memory","-"), c.get("kubeReserved",{}).get("memory","-"), c.get("containerLogMaxSize","-"))' 2>/dev/null || true)
  read -r a b c d e <<<"$cfg"
  [[ ${a:-} == 500Mi && ${b:-} == True && ${c:-} == 2Gi && ${d:-} == 1Gi ]] && ok "kubelet: evictionHard memory=$a, singleProcessOOMKill=$b, reservas $c/$d, logs $e" \
    || fail "kubelet não carregou kubelet-fiapx.yaml (configz: ${cfg:-vazio})"
  info "oom_score_adj do k3s: $(cat "/proc/$(pgrep -xo k3s-server 2>/dev/null || pgrep -o k3s)/oom_score_adj" 2>/dev/null) (esperado -999)"

  section "Rede e firewall"
  extra=$(ss -Hlntup 2>/dev/null | awk '{print $1, $5, $7}' | grep -vE ' (127\.[0-9.]+|\[::1\]|[^ ]*%lo):' | grep -vE ':(22|80|443|5353|68) ' || true)
  if grep -q ':8472 ' <<<"$extra"; then fail "VXLAN 8472 escutando (flannel deveria ser host-gw)"; fi
  if grep -vE ':(6443|10250) .*k3s' <<<"$extra" | matches .; then warn "listeners novos além de 6443/10250:"; grep -vE ':(6443|10250) .*k3s' <<<"$extra" | sed 's/^/          /'
  else ok "listeners não-loopback novos: só 6443 e 10250 (atrás do UFW)"; fi
  rules=$(iptables -t nat -S KUBE-SERVICES 2>/dev/null | grep -- '-j KUBE-NODEPORTS' || true)
  if grep -q -- "-d $gw/32" <<<"$rules" && ! grep -q -- '--dst-type LOCAL' <<<"$rules"; then ok "NodePorts só em $gw (nodeport-addresses)"
  else fail "NodePorts não restritos a $gw: $rules"; fi
  # IPv6: sem um CIDR IPv6 no nodeport-addresses, o kube-proxy publica NodePort em TODOS os IPv6
  # do nó ("--dst-type LOCAL"). Com o CIDR de documentação, não há regra nenhuma (o esperado).
  rules=$(ip6tables -t nat -S KUBE-SERVICES 2>/dev/null | grep -- '-j KUBE-NODEPORTS' || true)
  if [[ -z $rules ]]; then ok "IPv6: nenhum NodePort publicado (nodeport-addresses com CIDR IPv6 inexistente)"
  else fail "IPv6: NodePorts publicados ($rules). Confira o nodeport-addresses no config.yaml e reinicie o k3s"; fi
  [[ $(ip6tables -S INPUT 2>/dev/null | head -1) == "-P INPUT DROP" ]] && ok "IPv6 INPUT policy DROP" || fail "IPv6 INPUT policy mudou"
  [[ -z $(cat /proc/net/ip_tables_names 2>/dev/null) ]] && ok "sem tabelas legacy (backends não misturados)" || fail "tabelas iptables-legacy apareceram"
  [[ $(iptables -S INPUT | head -1) == "-P INPUT DROP" ]] && ok "INPUT policy DROP" || fail "INPUT policy mudou"
  [[ $(iptables -S FORWARD | head -1) == "-P FORWARD DROP" ]] && ok "FORWARD policy DROP (ignore o log do flannel que diz ACCEPT)" || fail "FORWARD policy mudou"
  (( $(iptables-save | grep -c 'KUBE-ROUTER' || true) == 0 )) && ok "sem kube-router (controlador de NetworkPolicy desligado)" || warn "cadeias KUBE-ROUTER presentes (disable-network-policy não pegou?)"
  [[ $(sysctl -n net.ipv4.conf.all.route_localnet) == 0 ]] && ok "route_localnet=0" || fail "route_localnet=1"
  ip link show flannel.1 >/dev/null 2>&1 && fail "flannel.1 existe (VXLAN)" || ok "sem flannel.1 (host-gw)"
  ip -4 -br addr show cni0 2>/dev/null | matches '10.42.0.1/24' && ok "cni0 = 10.42.0.1/24" || warn "cni0 ainda não existe (nenhum pod de rede de pod?)"
  (( $(iptables -t raw -S PREROUTING | grep -c fiapx-guard || true) == 3 )) && ok "guarda raw IPv4 (Docker -> pods/ClusterIP, pods -> metadata, SYN de fora nas portas do K3s)" || fail "guarda raw IPv4 incompleta (esperado 3 regras fiapx-guard): ./20-firewall.sh --yes"
  (( $(ip6tables -t raw -S PREROUTING | grep -c fiapx-guard-k8s-ports || true) == 1 )) && ok "guarda raw IPv6 (SYN de fora nas portas do K3s)" || fail "guarda raw IPv6 ausente: ./20-firewall.sh --yes"
  systemctl is-active --quiet fiapx-netguard.service && ok "fiapx-netguard ativo" || fail "fiapx-netguard inativo"
  grep -q 'ExecStartPre=.*is-active.*fiapx-netguard' /etc/systemd/system/k3s.service.d/10-fiapx.conf 2>/dev/null \
    && ok "K3s só sobe com a guarda ativa (ExecStartPre no drop-in)" || fail "drop-in do K3s sem o ExecStartPre da guarda: ./10-install-k3s.sh --yes"
  ufw show added 2>/dev/null | matches 'in on cni0 from 10.42.0.0/16 to any port 6443,10250 proto tcp' && ok "UFW: pods -> apiserver/kubelet via cni0" || fail "regra UFW da cni0 ausente"
  if [[ -f $STATE_DIR/snapshot-antes/iptables-v4.rules ]]; then
    if diff <(grep -E 'DOCKER|br-' "$STATE_DIR/snapshot-antes/iptables-v4.rules" | sed 's/\[[0-9:]*\]//' | sort) \
            <(iptables-save | grep -E 'DOCKER|br-' | sed 's/\[[0-9:]*\]//' | sort) >/dev/null; then ok "regras do Docker idênticas ao snapshot de antes"
    else warn "regras do Docker diferem do snapshot (normal se um vizinho fez deploy: IP de container muda). Compare: diff <(grep -E 'DOCKER|br-' $STATE_DIR/snapshot-antes/iptables-v4.rules) <(iptables-save | grep -E 'DOCKER|br-')"; fi
  fi

  section "Ingress e borda"
  check_neighbors
  check_edge_sites
  if k get ns traefik >/dev/null 2>&1; then
    [[ $(k -n traefik get svc traefik -o jsonpath='{.spec.type} {.spec.ports[?(@.name=="web")].nodePort}' 2>/dev/null) == "NodePort $NODEPORT" ]] \
      && ok "Service traefik: NodePort $NODEPORT" || fail "Service traefik não é NodePort $NODEPORT"
    code=$(http_code -H "Host: $PUBLIC_HOST" "http://$gw:$NODEPORT/api/health/live")
    [[ $code =~ ^(200|404)$ ]] && ok "host -> $gw:$NODEPORT: HTTP $code" || fail "host -> $gw:$NODEPORT: HTTP $code"
    code=$(docker exec "$EDGE" wget -q -S -O /dev/null -T 5 --header "Host: $PUBLIC_HOST" "http://$gw:$NODEPORT/api/health/live" 2>&1 | awk '/HTTP\//{print $2; exit}')
    [[ ${code:-} =~ ^(200|404)$ ]] && ok "edge-caddy -> $gw:$NODEPORT: HTTP $code (o caminho real do Caddy)" || fail "edge-caddy não alcança $gw:$NODEPORT (${code:-sem resposta})"
  else info "Traefik ainda não instalado (30-ingress.sh)"; fi
  local site f h
  for site in "${SITES[@]}"; do
    f=${site%%:*} h=${site#*:}
    if [[ -f /opt/edge/sites/$f ]]; then
      cmp -s "$SCRIPT_DIR/$f" "/opt/edge/sites/$f" 2>/dev/null && ok "$f igual ao do repo" || warn "$f na borda difere do repo: ./30-ingress.sh --caddy (diff)"
      code=$(edge_code "$h" /api/health/live)
      [[ $code == 200 ]] && ok "$h pela borda local: HTTP 200" || warn "$h pela borda local: HTTP $code (app ainda não publicado?)"
      # HTTP puro (visitante em http://, ou direto na origem) precisa virar 308 para https://.
      code=$(http_code -H "Host: $h" "http://127.0.0.1/api/health/live")
      [[ $code == 308 ]] && ok "$h em HTTP puro: 308 para https://" || fail "$h em HTTP puro: HTTP $code (esperado 308; texto puro de ponta a ponta): ./30-ingress.sh --caddy --yes"
    else info "$f ainda não instalado (30-ingress.sh --caddy)"; fi
  done

  section "Disco"
  findmnt -rn -o SOURCE /var/lib/rancher 2>/dev/null | matches '^/dev/loop' && ok "/var/lib/rancher no loop: $(df -h --output=used,size,pcent /var/lib/rancher | tail -1 | xargs)" || fail "/var/lib/rancher não está no disco em loop"
  losetup -j "$PV_IMG" 2>/dev/null | matches . && findmnt -rn "$PV_DIR" >/dev/null 2>&1 \
    && ok "$PV_DIR (volumes) no loop próprio: $(df -h --output=used,size,pcent "$PV_DIR" | tail -1 | xargs)" || fail "$PV_DIR não está no loop dos volumes: ./10-install-k3s.sh --yes"
  k -n kube-system get cm local-path-config -o jsonpath='{.data.config\.json}' 2>/dev/null | matches -F "\"$PV_DIR\"" \
    && ok "local-path grava os PVCs em $PV_DIR" || fail "local-path não usa $PV_DIR (default-local-storage-path no config.yaml + systemctl restart k3s)"
  info "/ : $(df -h --output=used,size,pcent,avail / | tail -1 | xargs)"

  section "Acesso do CD"
  if [[ -f $DEPLOY_HOME/kubeconfig ]]; then
    local q r expect
    # "recurso/nome" no can-i é NOME de objeto: subrecurso vai em --subresource.
    for q in "create deployments -n fiapx:yes" "patch daemonsets -n fiapx:yes" "get secrets -n fiapx:no" \
             "create deployments -n kube-system:no" "create pods --subresource=exec -n fiapx:no" \
             "patch resourcequotas -n fiapx:no" "create rolebindings -n fiapx:no"; do
      expect=${q##*:}; q=${q%:*}
      # shellcheck disable=SC2086
      r=$(runuser -u fiapx-deploy -- env KUBECONFIG="$DEPLOY_HOME/kubeconfig" HOME=/tmp /usr/local/bin/kubectl auth can-i $q 2>/dev/null || true)
      [[ $r == "$expect" ]] && ok "deployer: can-i $q = $r" || fail "deployer: can-i $q = '$r' (esperado $expect)"
    done
    grep -q '^restrict,command="/opt/fiapx/bin/deploy.sh" ' "$DEPLOY_HOME/.ssh/authorized_keys" 2>/dev/null && ok "authorized_keys com restrict + forced command" || fail "authorized_keys sem restrict/forced command"
    n=$(k get validatingadmissionpolicy fiapx-sem-guaranteed -o jsonpath='{.spec.validations[*].expression}' 2>/dev/null | grep -c priorityClassName || true)
    (( n >= 1 )) && ok "política do namespace barra priorityClassName fora das fiapx-*" || fail "política fiapx-sem-guaranteed sem a regra de priorityClassName: ./40-deployer-access.sh --yes"
    k -n fiapx get resourcequota fiapx-sem-prioridade-de-sistema >/dev/null 2>&1 && ok "quota de 0 pods com PriorityClass do sistema" || fail "quota fiapx-sem-prioridade-de-sistema ausente: ./40-deployer-access.sh --yes"
    [[ $(k -n fiapx get resourcequota fiapx-teto -o jsonpath='{.spec.hard.requests\.storage}' 2>/dev/null) == 8Gi ]] \
      && ok "quota de volumes = 8Gi (= loop dos volumes)" || fail "quota fiapx-teto desatualizada (requests.storage != 8Gi): ./40-deployer-access.sh --yes"
    [[ $(k auth can-i list pods -n fiapx --as=system:serviceaccount:fiapx:prometheus 2>/dev/null) == yes \
       && $(k auth can-i get pods --subresource=log -n fiapx --as=system:serviceaccount:fiapx:alloy 2>/dev/null) == yes ]] \
      && ok "RBAC da observabilidade (prometheus lista pods, alloy lê logs; só no fiapx)" || fail "RBAC da observabilidade ausente: ./40-deployer-access.sh --yes"
  else info "acesso do CD ainda não criado (40-deployer-access.sh)"; fi

  section "KEDA"
  if k -n kube-system get helmchart keda >/dev/null 2>&1; then
    for n in keda-operator keda-operator-metrics-apiserver keda-admission-webhooks; do
      [[ $(k -n keda get deploy "$n" -o jsonpath='{.status.readyReplicas}' 2>/dev/null) -ge 1 ]] 2>/dev/null && ok "keda/$n pronto" || fail "keda/$n não está pronto"
    done
    # APIService indisponível atrapalha a descoberta de APIs do cluster inteiro (kubectl, namespace preso).
    [[ $(k get apiservice v1beta1.external.metrics.k8s.io -o jsonpath='{.status.conditions[?(@.type=="Available")].status}' 2>/dev/null) == True ]] \
      && ok "APIService external.metrics.k8s.io disponível (o HPA do KEDA lê a fila por ela)" || fail "APIService v1beta1.external.metrics.k8s.io indisponível: k3s kubectl -n keda logs deploy/keda-operator-metrics-apiserver"
  else info "KEDA não instalado (./35-keda.sh --yes)"; fi

  summary
}

# ================================================================== DE FORA (Mac)
outside_checks() {
  local ip=${1:-$VM_PUBLIC_IP} ip6=${2:-$VM_PUBLIC_IP6} p code h site nc_to=(-w 3)
  have nc || { fail "falta o nc"; summary; }
  [[ -n $ip ]] || { fail "sem IPv4 da VM: passe como argumento ou defina VM_PUBLIC_IP ($(site_env_hint))"; summary; }
  [[ $(nc -h 2>&1) =~ [[:space:]]-G[[:space:]] ]] && nc_to=(-G 3)   # nc do macOS: -G é o timeout de conexão
  section "Portas do K3s vistas da internet ($ip): todas precisam estar FECHADAS"
  for p in 6443 10250 10256 "$NODEPORT" 30000 30099; do
    if nc -z "${nc_to[@]}" "$ip" "$p" >/dev/null 2>&1; then fail "tcp/$p ABERTA de fora"; else ok "tcp/$p fechada/filtrada"; fi
  done
  section "Portas do K3s em IPv6 ($ip6): 6443/10250 escutam em '*', que inclui o IPv6 público"
  # Controle positivo: a 22 é aberta em IPv6 pelo UFW. Se nem ela conecta, este host não tem
  # rota IPv6 e a sondagem não prova nada: rode de um host com IPv6 (celular em 4G/5G costuma ter).
  if [[ -z $ip6 ]]; then
    warn "IPv6 NÃO verificado: sem VM_PUBLIC_IP6 (passe como 2º argumento ou no .env)"
  elif nc -6 -z "${nc_to[@]}" "$ip6" 22 >/dev/null 2>&1; then
    ok "tcp6/22 alcançável (este host tem IPv6: a sondagem vale)"
    for p in 6443 10250 10256 "$NODEPORT" 30000 30099; do
      if nc -6 -z "${nc_to[@]}" "$ip6" "$p" >/dev/null 2>&1; then fail "tcp6/$p ABERTA de fora"; else ok "tcp6/$p fechada/filtrada"; fi
    done
  else
    warn "IPv6 NÃO verificado: este host não alcança [$ip6]:22 (sem rota IPv6?). Repita de um host com IPv6"
  fi
  section "Sites pela Cloudflare"
  [[ -n ${NEIGHBOR_SITES// /} ]] || warn "NEIGHBOR_SITES vazio: não confiro os vizinhos ($(site_env_hint))"
  for h in $NEIGHBOR_SITES; do
    code=$(http_code "https://$h/"); [[ $code =~ ^[23] ]] && ok "$h: HTTP $code" || fail "$h: HTTP $code"
  done
  for site in "${SITES[@]}"; do
    h=${site#*:}
    code=$(http_code "https://$h/api/health/live")
    case $code in
      200) ok "$h/api/health/live: 200 ($(curl -s --max-time 8 "https://$h/api/health/live"))" ;;
      308) fail "$h: 308 em loop: a Cloudflare fala HTTP com a origem (Flexible) e o bloco http:// não está no site (README, D16)" ;;
      52[0-9]) fail "$h: HTTP $code da Cloudflare (526 = certificado da origem inválido para o Full strict; 521/522 = origem fora): confira o edge-caddy e o ${site%%:*}" ;;
      *) warn "$h/api/health/live: HTTP $code (404 = Traefik sem rota: app ainda não publicado)" ;;
    esac
    # http:// (visitante sem TLS) nunca pode ser atendido: login e JWT iriam em texto puro.
    # 30x vem do Caddy (@texto_puro) ou da própria Cloudflare ("Always Use HTTPS").
    code=$(http_code "http://$h/api/health/live")
    if [[ $code =~ ^30[1278]$ ]]; then ok "http://$h: HTTP $code (redireciona para https://)"
    elif [[ $code == 000 ]]; then fail "http://$h: sem resposta (rede, DNS ou Cloudflare)"
    else fail "http://$h: HTTP $code (atendido em texto puro; esperado 301/308): ./30-ingress.sh --caddy --yes"; fi
  done
  summary
}

case ${1:-} in
  "")         pre_checks ;;
  --post)     post_checks ;;
  --outside)  outside_checks "${2:-}" "${3:-}" ;;
  -h|--help)  usage; exit 0 ;;
  *)          usage >&2; exit 2 ;;
esac
