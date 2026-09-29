#!/usr/bin/env bash
# infra/vm/20-firewall.sh — ajustes de firewall para o K3s conviver com Docker + UFW na VM.
# Roda ANTES do primeiro start do K3s (ordem na README): as regras já precisam existir quando
# o CoreDNS e o metrics-server subirem.
#
# Uso (root, na VM):
#   ./20-firewall.sh                 dry-run: mostra exatamente o que faria (padrão)
#   ./20-firewall.sh --yes           aplica (idempotente: rodar de novo não duplica nada)
#   ./20-firewall.sh --revert        dry-run da reversão
#   ./20-firewall.sh --revert --yes  desfaz tudo o que este script criou
#
# O que muda (e só isto):
#   1. net.ipv4.conf.all.route_localnet=0 (hoje 1, sobra da Fase 2; fecha a CVE-2020-8558)
#   2. UFW, 3 regras restritas à interface cni0 (a bridge dos pods):
#        allow in on cni0 from 10.42.0.0/16 to any port 6443,10250 proto tcp  (pods -> apiserver/kubelet)
#        route allow in on cni0 out on <saída> from 10.42.0.0/16             (pods -> internet)
#        route allow in on cni0 out on cni0 from 10.42.0.0/16 to 10.42.0.0/16 (pod <-> pod)
#      NÃO abre 6443 para a internet e NÃO libera 10.43.0.0/16 (ver README, "Decisões").
#   3. fiapx-netguard.service: regras na tabela raw (avaliada antes de tudo, independe da
#      ordem das cadeias do FORWARD e NÃO depende do UFW):
#        IPv4 DROP 172.16.0.0/12 -> 10.42.0.0/15   (containers do Docker não alcançam pods/ClusterIPs)
#        IPv4 DROP 10.42.0.0/16 -> 169.254.169.254 (pods não leem o metadata do provedor)
#        IPv4 e IPv6: DROP de SYN novo entrando pela <saída> (eth0) nas portas do K3s
#             6443, 10250, 10256 e NodePorts 30000-30099 (defesa em profundidade: se o UFW for
#             desligado ou o kube-proxy publicar NodePort em IPv6, a internet segue sem acesso)
#      O serviço tenta de novo sozinho se o iptables falhar no boot (Restart=on-failure), e o
#      K3s só sobe com ele ativo (ExecStartPre no drop-in do 10-install-k3s.sh).
# Nenhuma regra toca 80/443, a DOCKER-USER ou as cadeias do Docker.
set -Eeuo pipefail
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

readonly STATE_DIR=/root/fiapx-k3s
readonly POD_CIDR=10.42.0.0/16
readonly GUARD_SCRIPT=/usr/local/sbin/fiapx-netguard.sh
readonly GUARD_UNIT=/etc/systemd/system/fiapx-netguard.service
readonly SYSCTL_FILE=/etc/sysctl.d/90-fiapx-net.conf

APPLY=0 REVERT=0
for arg in "$@"; do
  case $arg in
    --yes) APPLY=1 ;;
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
put_file() {  # put_file <caminho> <modo>  (conteúdo no stdin; idempotente, com backup)
  local path=$1 mode=$2 tmp
  tmp=$(mktemp); cat > "$tmp"
  if [[ -f $path ]] && cmp -s "$tmp" "$path"; then done_ "$path"; rm -f "$tmp"; return 0; fi
  if (( APPLY )); then
    [[ -f $path ]] && cp -a -- "$path" "$path.fiapx-bak.$(date +%Y%m%d%H%M%S)"
    install -D -o root -g root -m "$mode" "$tmp" "$path"
    info "gravado $path ($mode)"
  elif [[ -f $path ]]; then
    printf '    [dry-run] alterar %s:\n' "$path"; diff -u "$path" "$tmp" | sed 's/^/        /' || true
  else
    printf '    [dry-run] criar %s (%s):\n' "$path" "$mode"; sed 's/^/        /' "$tmp"
  fi
  rm -f "$tmp"
}

snapshot() {  # estado de ANTES de qualquer mudança (base do diff e do rollback); só uma vez
  local dir=$STATE_DIR/snapshot-antes
  if [[ -d $dir ]]; then done_ "snapshot inicial já existe em $dir"; return 0; fi
  if (( ! APPLY )); then printf '    [dry-run] salvar iptables, ufw, rotas, portas, containers, sysctl e fstab em %s\n' "$dir"; return 0; fi
  install -d -m 0700 "$dir"
  iptables-save > "$dir/iptables-v4.rules"
  ip6tables-save > "$dir/iptables-v6.rules"
  ss -Hlntup > "$dir/listeners.txt"
  ip -br addr > "$dir/ip-addr.txt"; ip route > "$dir/ip-route.txt"
  ufw status verbose > "$dir/ufw-status.txt"; ufw show added > "$dir/ufw-added.txt"
  docker ps --format '{{.Names}}\t{{.Status}}\t{{.Networks}}' > "$dir/docker-ps.txt"
  sysctl -a > "$dir/sysctl.txt" 2>/dev/null || true
  cp /etc/fstab "$dir/fstab"; findmnt -l > "$dir/mounts.txt"
  # Quais diretórios que o K3s usa já existiam (o 99-uninstall.sh só remove os que ele criou).
  for d in /var/lib/rancher /var/lib/kubelet /var/log/pods /var/log/containers /etc/rancher; do
    if [[ -e $d ]]; then echo "$d"; fi
  done > "$dir/dirs-existentes.txt"
  info "snapshot salvo em $dir"
}

ufw_has() { ufw show added 2>/dev/null | matches -F -- "$1"; }

# ------------------------------------------------------------------ pré-condições
[[ $EUID -eq 0 ]] || die "rode como root"
if (( ! REVERT )); then   # a reversão funciona mesmo com o UFW desligado (as regras ficam no arquivo dele)
  ufw status 2>/dev/null | matches '^Status: active' || die "UFW não está ativo; este script assume o UFW ativo da VM"
fi
EGRESS_IF=$(ip -4 -o route show default | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')
[[ -n $EGRESS_IF ]] || die "não achei a interface da rota default"

readonly R_INPUT="allow in on cni0 from $POD_CIDR to any port 6443,10250 proto tcp"
readonly R_EGRESS="route allow in on cni0 out on $EGRESS_IF from $POD_CIDR"
readonly R_PODPOD="route allow in on cni0 out on cni0 from $POD_CIDR to $POD_CIDR"

# ------------------------------------------------------------------ reversão
if (( REVERT )); then
  (( APPLY )) || echo "(dry-run: nada será alterado; use --revert --yes)"
  step "1. UFW: remover as regras da cni0"
  for r in "$R_INPUT" "$R_EGRESS" "$R_PODPOD"; do
    if ufw_has "ufw $r"; then
      # Regra de rota se apaga com "ufw route delete allow ...", a de entrada com "ufw delete allow ...".
      # shellcheck disable=SC2086  # a regra precisa virar palavras separadas para o ufw
      if [[ $r == route\ * ]]; then run ufw route delete ${r#route }; else run ufw delete $r; fi
    else done_ "não existe: ufw $r"; fi
  done
  step "2. Guarda raw (fiapx-netguard)"
  if [[ -f $GUARD_UNIT ]]; then
    run systemctl disable --now fiapx-netguard.service   # o ExecStop remove as regras (IPv4 e IPv6)
    run rm -f "$GUARD_UNIT" "$GUARD_SCRIPT"
    run systemctl daemon-reload
  else done_ "fiapx-netguard não instalado"; fi
  for ipt in iptables ip6tables; do
    if "$ipt" -t raw -S PREROUTING | matches fiapx-guard; then
      info "sobraram regras fiapx-guard ($ipt); removendo uma a uma"
      "$ipt" -t raw -S PREROUTING | grep fiapx-guard | sed 's/^-A /-D /' | while read -r line; do
        # shellcheck disable=SC2086
        run "$ipt" -w 30 -t raw $line
      done
    fi
  done
  step "3. sysctl"
  if [[ -f $SYSCTL_FILE ]]; then run rm -f "$SYSCTL_FILE"; else done_ "$SYSCTL_FILE não existe"; fi
  info "route_localnet fica em 0 de propósito (nada na VM depende do valor 1; o padrão do boot já é 0)."
  step "Conferência"
  ufw status numbered | sed 's/^/    /'
  (( APPLY )) || echo -e "\n(dry-run) Para aplicar: $0 --revert --yes"
  exit 0
fi

# ------------------------------------------------------------------ aplicação
(( APPLY )) || echo "(dry-run: nada será alterado; use --yes para aplicar)"

step "0. Snapshot do estado atual (base do rollback)"
snapshot

step "1. route_localnet=0 (hoje: $(sysctl -n net.ipv4.conf.all.route_localnet))"
info "Com 1, um pod com CAP_NET_RAW forja pacote para 127.0.0.1 e alcança serviços do host"
info "que só escutam em loopback (gateways locais, resolved). Nada na VM depende do 1."
put_file "$SYSCTL_FILE" 0644 <<'EOF'
# Gerado por infra/vm/20-firewall.sh (fiapx). Removido por 20-firewall.sh --revert.
# route_localnet=1 (sobra do kube-proxy da Fase 2) deixa pacotes para 127.0.0.0/8 serem
# roteados vindos de fora da loopback: com pods na VM isso expõe serviços locais (CVE-2020-8558).
net.ipv4.conf.all.route_localnet = 0
EOF
if [[ $(sysctl -n net.ipv4.conf.all.route_localnet) != 0 ]]; then run sysctl -w net.ipv4.conf.all.route_localnet=0; else done_ "route_localnet já é 0"; fi

step "2. UFW: regras restritas à cni0"
info "Pod -> ClusterIP do apiserver (10.43.0.1:443) vira DNAT para <ip-do-nó>:6443 e cai no INPUT;"
info "o metrics-server fala com o kubelet em :10250 pelo mesmo caminho. 'in on cni0' impede que"
info "alguém forje origem 10.42.x pela eth0. As regras 'route' só silenciam falsos [UFW BLOCK]:"
info "o FLANNEL-FWD já aceitaria esse tráfego, mas depois de logar."
for r in "$R_INPUT|fiapx-k3s: pods->apiserver/kubelet" "$R_EGRESS|fiapx-k3s: pods->internet" "$R_PODPOD|fiapx-k3s: pod<->pod"; do
  rule=${r%%|*} comment=${r#*|}
  if ufw_has "ufw $rule"; then done_ "ufw $rule"
  else
    # shellcheck disable=SC2086
    run ufw $rule comment "$comment"
  fi
done

step "3. Guarda de isolamento na tabela raw (fiapx-netguard.service)"
info "Na raw o pacote ainda não passou por NAT nem pelo FORWARD: a regra vale qualquer que"
info "seja a ordem das cadeias do Docker/K3s/UFW. O Caddy -> 172.18.0.1:30080 não casa (destino"
info "é o gateway, pré-DNAT) e a volta pod -> Caddy também não (origem 10.42.x)."
info "As portas do K3s ($EGRESS_IF, IPv4 e IPv6) só casam SYN novo: resposta de conexão que a VM"
info "abriu (SYN-ACK/ACK) nunca é descartada, mesmo que o NAT tenha escolhido uma dessas portas."
# O heredoc é literal ('EOF'); só a interface de saída é trocada depois, pelo sed.
sed "s/@EGRESS_IF@/$EGRESS_IF/g" <<'EOF' | put_file "$GUARD_SCRIPT" 0755
#!/bin/sh
# fiapx-netguard: isolamento Docker <-> K3s na tabela raw. Gerado por infra/vm/20-firewall.sh.
# Os comentários evitam "KUBE-", "CNI-" e "flannel" para o k3s-killall/uninstall não apagá-los.
set -eu
PORTS="6443,10250,10256,30000:30099"
V4_1="-s 172.16.0.0/12 -d 10.42.0.0/15 -m comment --comment fiapx-guard-docker-to-k8s -j DROP"
V4_2="-s 10.42.0.0/16 -d 169.254.169.254/32 -m comment --comment fiapx-guard-pod-metadata -j DROP"
PUB="-i @EGRESS_IF@ -p tcp --syn -m multiport --dports $PORTS -m comment --comment fiapx-guard-k8s-ports -j DROP"

# -w 30: espera o lock do xtables (o dockerd pode estar recriando as regras dele no boot).
# 3 tentativas: um erro passageiro não deixa o serviço "failed" (e o K3s parado) à toa.
try() { n=0; until "$@"; do n=$((n + 1)); [ "$n" -lt 3 ] || return 1; sleep 2; done; }
add1() { ipt=$1; shift; "$ipt" -w 30 -t raw -C PREROUTING "$@" 2>/dev/null || try "$ipt" -w 30 -t raw -A PREROUTING "$@"; }
del1() { ipt=$1; shift; while "$ipt" -w 30 -t raw -C PREROUTING "$@" 2>/dev/null; do try "$ipt" -w 30 -t raw -D PREROUTING "$@"; done; }

# shellcheck disable=SC2086  # cada regra precisa virar palavras separadas
rules() {  # rules add1|del1
  "$1" iptables $V4_1
  "$1" iptables $V4_2
  "$1" iptables $PUB
  "$1" ip6tables $PUB
}

case "${1:-}" in
  add) rules add1 ;;
  del) rules del1 ;;
  *) echo "uso: $0 add|del" >&2; exit 2 ;;
esac
EOF
put_file "$GUARD_UNIT" 0644 <<'EOF'
# Gerado por infra/vm/20-firewall.sh (fiapx). Removido por 20-firewall.sh --revert.
[Unit]
Description=fiapx: isolamento Docker <-> K3s na tabela raw
After=docker.service
Before=k3s.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/fiapx-netguard.sh add
ExecStop=/usr/local/sbin/fiapx-netguard.sh del
# Falhou no boot (lock do xtables, por exemplo)? Tenta de novo a cada 5 s. O K3s não sobe sem
# este serviço ativo (ExecStartPre no drop-in do K3s) e sobe sozinho quando ele ficar ativo.
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF
if (( APPLY )); then
  run systemctl daemon-reload
  run systemctl enable fiapx-netguard.service
  run systemctl restart fiapx-netguard.service   # oneshot: restart = del + add (idempotente)
else
  run systemctl daemon-reload
  run systemctl enable --now fiapx-netguard.service
fi

step "Conferência"
ufw status numbered | sed 's/^/    /'
iptables -t raw -S PREROUTING | grep -E 'fiapx-guard' | sed 's/^/    IPv4 /' || info "(guarda raw IPv4 ainda não aplicada)"
ip6tables -t raw -S PREROUTING | grep -E 'fiapx-guard' | sed 's/^/    IPv6 /' || info "(guarda raw IPv6 ainda não aplicada)"
info "route_localnet = $(sysctl -n net.ipv4.conf.all.route_localnet)"
info "fiapx-netguard: $(systemctl is-active fiapx-netguard.service 2>/dev/null || true)"
if (( APPLY )); then
  echo -e "\nFirewall pronto. Próximo passo: ./10-install-k3s.sh (dry-run) e depois --yes."
  echo "Reverter: $0 --revert --yes"
else
  echo -e "\n(dry-run) Para aplicar: $0 --yes"
fi
