#!/usr/bin/env bash
# infra/vm/10-install-k3s.sh — instala o K3s single-node na VM compartilhada sem encostar nos vizinhos.
#
# Uso (root, na VM, DEPOIS do 20-firewall.sh --yes):
#   ./10-install-k3s.sh                  dry-run: mostra cada arquivo, comando e diff (padrão)
#   ./10-install-k3s.sh --yes            aplica e inicia o K3s (idempotente)
#   ./10-install-k3s.sh --yes --no-start aplica tudo, mas deixa o K3s parado
# Opções:
#   --loop-size 20G   tamanho do disco em loop de /var/lib/rancher (teto de TUDO do K3s no "/")
#   --pv-size 8G      tamanho do disco em loop SÓ dos volumes (PVCs), criado DENTRO do anterior
#   --swap 2G         cria /swapfile (decisão pendente do Arthur; padrão: sem swap)
#
# Passos: 0 pré-condições · 1 snapshot · 2 disco em loop do K3s · 2b disco em loop dos volumes ·
#         3 swap (opcional) · 4 sysctl · 5 configs (/etc/rancher/k3s/*, drop-in systemd) ·
#         6 instalador fixado · 7 start + espera
# Rodar de novo com o K3s no ar converge os arquivos; se algum mudou, o script AVISA e quem
# reinicia é você (systemctl restart k3s: os pods seguem rodando durante o restart).
# Versão fixada: K3s v1.36.4+k3s1 (canal stable em 2026-09-28). Upgrade: README, "Dia 2".
set -Eeuo pipefail
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

readonly K3S_VERSION=v1.36.4+k3s1
readonly INSTALLER_URL="https://raw.githubusercontent.com/k3s-io/k3s/${K3S_VERSION/+/%2B}/install.sh"
readonly BORDA_NET=borda
readonly STATE_DIR=/root/fiapx-k3s
readonly LOOP_IMG=/var/lib/fiapx-k3s.img
readonly RANCHER=/var/lib/rancher
readonly PV_IMG=$RANCHER/fiapx-pv.img        # dentro do loop do K3s: não aumenta o teto no "/"
readonly PV_DIR=/var/lib/fiapx-pv            # default-local-storage-path do local-path
# IPv6 de documentação (RFC 3849), que nenhuma interface tem: com um CIDR IPv6 na lista, o
# kube-proxy deixa de publicar NodePort em TODOS os IPv6 do nó (sem ele, IPv6 = "todos").
readonly NODEPORT_V6_NONE=2001:db8::1/128
readonly CONF_DIR=/etc/rancher/k3s
readonly DROPIN=/etc/systemd/system/k3s.service.d/10-fiapx.conf
readonly SYSCTL_FILE=/etc/sysctl.d/90-fiapx-k3s.conf
readonly FSTAB_TAG="# fiapx-k3s"
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR

APPLY=0 START=1 LOOP_SIZE=20G PV_SIZE=8G SWAP_SIZE=""
while (( $# )); do
  case $1 in
    --yes) APPLY=1 ;;
    --no-start) START=0 ;;
    --loop-size) LOOP_SIZE=${2:?}; shift ;;
    --pv-size) PV_SIZE=${2:?}; shift ;;
    --swap) SWAP_SIZE=${2:?}; shift ;;
    -h|--help) sed -n '2,/^[^#]/{/^#/s/^# \{0,1\}//p;}' "$0"; exit 0 ;;
    *) echo "argumento desconhecido: $1 (use --help)" >&2; exit 2 ;;
  esac
  shift
done
[[ $LOOP_SIZE =~ ^[0-9]+G$ ]] || { echo "--loop-size precisa ser em G (ex.: 20G)" >&2; exit 2; }
[[ $PV_SIZE =~ ^[0-9]+G$ ]] || { echo "--pv-size precisa ser em G (ex.: 8G)" >&2; exit 2; }
# O disco dos volumes mora dentro do disco do K3s: precisa sobrar >= 10 GiB para imagens e datastore.
(( ${LOOP_SIZE%G} - ${PV_SIZE%G} >= 10 )) || { echo "--pv-size $PV_SIZE deixa menos de 10G para as imagens dentro de --loop-size $LOOP_SIZE" >&2; exit 2; }
[[ -z $SWAP_SIZE || $SWAP_SIZE =~ ^[0-9]+G$ ]] || { echo "--swap precisa ser em G (ex.: 2G)" >&2; exit 2; }

step()  { printf '\n==> %s\n' "$*"; }
info()  { printf '    %s\n' "$*"; }
done_() { printf '    [já feito] %s\n' "$*"; }
die()   { printf '\nERRO: %s\n' "$*" >&2; exit 1; }
matches() { grep "$@" >/dev/null; }  # = grep -q, mas lê a entrada toda: sem EPIPE no produtor sob pipefail
run() {
  if (( APPLY )); then printf '    $ %s\n' "$*"; "$@"
  else printf '    [dry-run] $ %s\n' "$*"; fi
}
CHANGED=()   # arquivos lidos pelo K3s no start que este run alterou (ou alteraria, no dry-run)
put_file() {  # put_file <caminho> <modo>  (conteúdo no stdin; idempotente, com backup)
  local path=$1 mode=$2 tmp
  tmp=$(mktemp); cat > "$tmp"
  if [[ -f $path ]] && cmp -s "$tmp" "$path"; then done_ "$path"; rm -f "$tmp"; return 0; fi
  CHANGED+=("$path")
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
fstab_add() {  # fstab_add <linha>  (backup + validação; nunca duplica)
  if grep -qF -- "$1" /etc/fstab; then done_ "fstab: $1"; return 0; fi
  if (( APPLY )); then
    cp -a /etc/fstab "/etc/fstab.fiapx-bak.$(date +%Y%m%d%H%M%S)"
    printf '%s\n' "$1" >> /etc/fstab
    findmnt --verify --tab-file /etc/fstab >/dev/null 2>&1 || info "AVISO: findmnt --verify reclamou do fstab; confira: findmnt --verify"
    info "fstab += $1"
  else printf '    [dry-run] acrescentar ao /etc/fstab: %s\n' "$1"; fi
}

k3s_installed_version() { /usr/local/bin/k3s --version 2>/dev/null | awk 'NR==1 {print $3}'; }

# ------------------------------------------------------------------ 0. pré-condições
(( APPLY )) || echo "(dry-run: nada será alterado; use --yes para aplicar)"
step "0. Pré-condições"
[[ $EUID -eq 0 ]] || die "rode como root"
INSTALLED=$(k3s_installed_version || true)
if [[ -n $INSTALLED && $INSTALLED != "$K3S_VERSION" ]]; then
  die "K3s $INSTALLED já instalado; este script fixa $K3S_VERSION. Upgrade é outro procedimento (README, 'Dia 2')."
fi
if [[ -z $INSTALLED ]]; then
  info "rodando o pré-flight (somente leitura)..."
  pf_out=$(mktemp)   # nome imprevisível (mktemp, 0600): nada de /tmp/<nome>.$$ escrito pelo root
  if ! "$SCRIPT_DIR/00-preflight.sh" > "$pf_out" 2>&1; then
    grep -E 'FALHA|Resumo' "$pf_out" | sed 's/^/    /'
    rm -f "$pf_out"
    (( APPLY )) && die "o 00-preflight.sh achou FALHAS; rode-o e resolva antes"
    info "(dry-run segue mesmo assim, só para você ver o plano)"
  else
    rm -f "$pf_out"; info "pré-flight sem falhas"
  fi
else
  info "K3s $INSTALLED já instalado: rodando de novo para conferir/convergir"
fi
FIREWALL_OK=1
ufw show added 2>/dev/null | matches -F 'in on cni0 from 10.42.0.0/16 to any port 6443,10250 proto tcp' || FIREWALL_OK=0
systemctl is-enabled --quiet fiapx-netguard.service 2>/dev/null || FIREWALL_OK=0
systemctl is-active --quiet fiapx-netguard.service 2>/dev/null || FIREWALL_OK=0
# Versão atual da guarda (com o bloqueio das portas do K3s na eth0, IPv4 e IPv6): o drop-in novo
# exige o fiapx-netguard ATIVO para o K3s subir.
for ipt in iptables ip6tables; do
  "$ipt" -t raw -S PREROUTING 2>/dev/null | matches fiapx-guard-k8s-ports || FIREWALL_OK=0
done
if (( ! FIREWALL_OK )); then
  (( APPLY && START )) && die "rode ./20-firewall.sh --yes ANTES: as regras (versão atual da guarda raw, IPv4 e IPv6) precisam existir e o fiapx-netguard estar ativo antes do start"
  info "AVISO: 20-firewall.sh (versão atual) ainda não aplicado ou fiapx-netguard inativo (obrigatório antes do start)"
fi
NODE_IP=$(ip -4 -o route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')
BORDA_GW=$(docker network inspect "$BORDA_NET" -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)
NAMESERVERS=$(awk '/^nameserver [0-9.]+$/ {print $2}' /run/systemd/resolve/resolv.conf)
[[ -n $NODE_IP ]] || die "não descobri o IP de saída (ip route get)"
[[ $BORDA_GW =~ ^[0-9.]+$ ]] || die "não descobri o gateway da rede docker '$BORDA_NET'"
[[ -n $NAMESERVERS ]] || die "nenhum resolver IPv4 em /run/systemd/resolve/resolv.conf"
info "node-ip=$NODE_IP · NodePorts só em $BORDA_GW · DNS upstream: $(echo "$NAMESERVERS" | tr '\n' ' ')"

# ------------------------------------------------------------------ 1. snapshot
step "1. Snapshot do estado atual"
if [[ -d $STATE_DIR/snapshot-antes ]]; then done_ "$STATE_DIR/snapshot-antes (criado pelo 20-firewall.sh)"
else
  (( APPLY )) && die "sem snapshot: o 20-firewall.sh --yes cria o snapshot-antes; rode-o primeiro"
  info "[dry-run] o 20-firewall.sh --yes cria o snapshot-antes"
fi

# ------------------------------------------------------------------ 2. disco em loop
step "2. Disco em loop para /var/lib/rancher (teto duro de $LOOP_SIZE para imagens, PVCs e datastore)"
info "O local-path não limita o tamanho de um PVC. Sem o loop, um Garage sem quota ou um WAL"
info "descontrolado enche o '/', que é onde estão os bancos dos vizinhos. O arquivo é esparso: só ocupa"
info "o que for escrito; 'discard' devolve ao '/' o que for apagado."
if findmnt -rn "$RANCHER" >/dev/null 2>&1; then
  losetup -j "$LOOP_IMG" | matches . || die "$RANCHER já é ponto de montagem de outra coisa: $(findmnt -rn -o SOURCE "$RANCHER")"
  done_ "$RANCHER montado de $LOOP_IMG"
else
  [[ -z $(ls -A "$RANCHER" 2>/dev/null) ]] || die "$RANCHER não está vazio; não vou montar por cima"
  if [[ -e $LOOP_IMG ]]; then done_ "$LOOP_IMG existe"; else run truncate -s "$LOOP_SIZE" "$LOOP_IMG"; run chmod 600 "$LOOP_IMG"; fi
  if [[ -e $LOOP_IMG ]] && blkid -p "$LOOP_IMG" 2>/dev/null | matches 'TYPE="ext4"'; then done_ "ext4 já criado em $LOOP_IMG"
  else run mkfs.ext4 -q -F -L fiapx-k3s -m 0 "$LOOP_IMG"; fi
  fstab_add "$LOOP_IMG $RANCHER ext4 loop,noatime,discard,nofail 0 0 $FSTAB_TAG"
  run install -d -m 0755 "$RANCHER"
  run systemctl daemon-reload
  run mount "$RANCHER"
fi

# ------------------------------------------------------------------ 2b. disco em loop dos volumes
step "2b. Disco em loop SÓ dos volumes (PVCs): $PV_DIR, $PV_SIZE, arquivo dentro de $RANCHER"
info "O kubelet trata $RANCHER como imagefs: acima de 75% ele apaga imagens, acima de 85/90% despeja"
info "pods. Nenhum dos dois libera dado de PVC; com os volumes no mesmo disco, a pressão ficaria"
info "presa (nenhum pod novo sobe, deploy e rollback falham). Num disco próprio, volume cheio só"
info "afeta quem escreve nele; o arquivo fica dentro do loop do K3s, então o teto no '/' continua $LOOP_SIZE."
if findmnt -rn "$PV_DIR" >/dev/null 2>&1; then
  losetup -j "$PV_IMG" 2>/dev/null | matches . || die "$PV_DIR já é ponto de montagem de outra coisa: $(findmnt -rn -o SOURCE "$PV_DIR")"
  done_ "$PV_DIR montado de $PV_IMG"
else
  [[ -z $(ls -A "$PV_DIR" 2>/dev/null) ]] || die "$PV_DIR não está vazio; não vou montar por cima"
  if [[ -e $PV_IMG ]]; then done_ "$PV_IMG existe"; else run truncate -s "$PV_SIZE" "$PV_IMG"; run chmod 600 "$PV_IMG"; fi
  if [[ -e $PV_IMG ]] && blkid -p "$PV_IMG" 2>/dev/null | matches 'TYPE="ext4"'; then done_ "ext4 já criado em $PV_IMG"
  else run mkfs.ext4 -q -F -L fiapx-pv -m 0 "$PV_IMG"; fi
  # x-systemd.requires-mounts-for: no boot, só monta depois do loop do K3s (onde o arquivo mora).
  fstab_add "$PV_IMG $PV_DIR ext4 loop,noatime,discard,nofail,x-systemd.requires-mounts-for=$RANCHER 0 0 $FSTAB_TAG"
  run install -d -m 0755 "$PV_DIR"
  run systemctl daemon-reload
  run mount "$PV_DIR"
fi

# ------------------------------------------------------------------ 3. swap (opcional)
step "3. Swap"
if [[ -z $SWAP_SIZE ]]; then info "sem --swap: nada a fazer (decisão pendente; ver README)"
elif swapon --noheadings --show=NAME | matches -x /swapfile; then done_ "/swapfile ativo"
else
  info "Os pods NÃO usam swap (kubelet NoSwap). Ela serve para o kernel tirar páginas frias de"
  info "processos fora do K8s em vez de descartar o cache dos vizinhos antes de um OOM."
  run fallocate -l "$SWAP_SIZE" /swapfile
  run chmod 600 /swapfile
  run mkswap /swapfile
  run swapon /swapfile
  fstab_add "/swapfile none swap sw 0 0 $FSTAB_TAG"
fi

# ------------------------------------------------------------------ 4. sysctl
step "4. sysctl (só aumenta limites; não muda o comportamento dos vizinhos)"
{
  echo "# Gerado por infra/vm/10-install-k3s.sh (fiapx). Removido pelo 99-uninstall.sh."
  echo "# Padrão do Ubuntu (128 instâncias) é baixo para kubelet + containerd + apps Node com watchers."
  echo "fs.inotify.max_user_instances = 1024"
  echo "fs.inotify.max_user_watches = 524288"
  if [[ -n $SWAP_SIZE ]]; then echo "# Com swap: só páginas realmente frias saem da RAM."; echo "vm.swappiness = 10"; fi
} | put_file "$SYSCTL_FILE" 0644
run sysctl -q -p "$SYSCTL_FILE"

# ------------------------------------------------------------------ 5. configs do K3s
step "5. Configuração do K3s (lida no start; o instalador não a sobrescreve)"
CHANGED=()   # daqui em diante, só o que o K3s lê no start
put_file "$CONF_DIR/config.yaml" 0600 <<EOF
# /etc/rancher/k3s/config.yaml — gerado por infra/vm/10-install-k3s.sh (não edite à mão).
# Cada chave equivale a uma flag de "k3s server" (--chave=valor). Motivos na infra/vm/README.md.
write-kubeconfig-mode: "0600"
node-ip: "$NODE_IP"
# Nó único: sem VXLAN (sem UDP 8472), rota direta para 10.42.0.0/24 na cni0.
flannel-backend: "host-gw"
disable:
  # OBRIGATÓRIO: o servicelb cria hostPort 80/443 e sequestraria a borda dos vizinhos.
  - servicelb
  # O Traefik é instalado à parte (30-ingress.sh), com versão de chart fixada.
  - traefik
# O controlador de NetworkPolicy (kube-router) reescreve a tabela filter inteira a cada sync
# (iptables-save | iptables-restore sem --noflush) e pode perder regras que o Docker acabou de criar.
disable-network-policy: true
service-node-port-range: "30000-30099"
kube-proxy-arg:
  # NodePort só no gateway da rede docker "borda": o Caddy alcança, a internet não.
  # O CIDR IPv6 não existe em nenhuma interface: sem ele o kube-proxy publicaria NodePort em
  # todos os IPv6 do nó (a lista vale por família; família sem CIDR = "todos os endereços").
  - "nodeport-addresses=$BORDA_GW/32,$NODEPORT_V6_NONE"
# Volumes (local-path) num disco próprio (passo 2b): PVC cheio não trava o imagefs do kubelet.
default-local-storage-path: "$PV_DIR"
kube-apiserver-arg:
  # DenyServiceExternalIPs: um Service com externalIPs=<ip público> sequestraria 80/443.
  - "enable-admission-plugins=NodeRestriction,DenyServiceExternalIPs"
  # Pod Security "baseline" como padrão do cluster (o K3s 1.36 não tem flag própria para isso).
  - "admission-control-config-file=$CONF_DIR/psa.yaml"
resolv-conf: "$CONF_DIR/resolv.conf"
secrets-encryption: true
kubelet-arg:
  - "config=$CONF_DIR/kubelet-fiapx.yaml"
# NÃO usar: prefer-bundled-bin, kube-proxy proxy-mode=nftables, cluster-init (etcd).
EOF

put_file "$CONF_DIR/kubelet-fiapx.yaml" 0644 <<'EOF'
# /etc/rancher/k3s/kubelet-fiapx.yaml — gerado por infra/vm/10-install-k3s.sh.
# O K3s copia este arquivo para agent/etc/kubelet.conf.d/ (merge sobre os padrões dele).
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
# Reservas: CONTABILIDADE. Com enforceNodeAllocatable=[pods], só o kubepods.slice recebe
# memory.max = RAM - systemReserved - kubeReserved (~4,57 GiB). O system.slice (vizinhos, Docker,
# sshd) NÃO ganha limite nenhum.
systemReserved:            # vizinhos + Docker + SO (soma dos picos medidos ~1,75 GiB)
  cpu: "1000m"
  memory: "2Gi"
  ephemeral-storage: "40Gi"
kubeReserved:              # k3s-server + containerd do K3s + shims
  cpu: "500m"
  memory: "1Gi"
  ephemeral-storage: "2Gi"
enforceNodeAllocatable: ["pods"]
# O padrão do K3s só define imagefs/nodefs: sem isto NÃO existe despejo por falta de memória.
evictionHard:
  memory.available: "500Mi"
  nodefs.available: "10%"      # nodefs = "/" compartilhado com os vizinhos
  nodefs.inodesFree: "5%"
  imagefs.available: "10%"     # imagefs = o loop /var/lib/rancher
  imagefs.inodesFree: "5%"
evictionSoft:
  memory.available: "750Mi"
  nodefs.available: "15%"
  imagefs.available: "15%"
evictionSoftGracePeriod:
  memory.available: "1m30s"
  nodefs.available: "2m"
  imagefs.available: "2m"
evictionMaxPodGracePeriod: 60
evictionMinimumReclaim:
  memory.available: "256Mi"
  nodefs.available: "1Gi"
  imagefs.available: "2Gi"
evictionPressureTransitionPeriod: "2m"
# OOM dentro do limite de um container mata só o processo culpado (o ffmpeg), não o pod todo.
singleProcessOOMKill: true
imageGCHighThresholdPercent: 75
imageGCLowThresholdPercent: 60
imageMinimumGCAge: "10m"
imageMaximumGCAge: "168h"
serializeImagePulls: false
maxParallelImagePulls: 2
containerLogMaxSize: "10Mi"
containerLogMaxFiles: 3
podPidsLimit: 1024
maxPods: 40
EOF

put_file "$CONF_DIR/psa.yaml" 0644 <<'EOF'
# /etc/rancher/k3s/psa.yaml — gerado por infra/vm/10-install-k3s.sh.
# Padrão do cluster inteiro: Pod Security "baseline" (sem privileged, hostPath, hostNetwork,
# hostPort). Só o kube-system fica isento (helpers do local-path e do helm-controller).
apiVersion: apiserver.config.k8s.io/v1
kind: AdmissionConfiguration
plugins:
  - name: PodSecurity
    configuration:
      apiVersion: pod-security.admission.config.k8s.io/v1
      kind: PodSecurityConfiguration
      defaults:
        enforce: "baseline"
        enforce-version: "latest"
        audit: "restricted"
        audit-version: "latest"
        warn: "restricted"
        warn-version: "latest"
      exemptions:
        usernames: []
        runtimeClasses: []
        namespaces: ["kube-system"]
EOF

# < <(...) e não "| put_file": num pipe o put_file rodaria num subshell e o CHANGED se perderia.
put_file "$CONF_DIR/resolv.conf" 0644 < <(
  echo "# /etc/rancher/k3s/resolv.conf — gerado por infra/vm/10-install-k3s.sh."
  echo "# Upstream do CoreDNS só IPv4: o cluster é IPv4-only e o resolv.conf do systemd lista IPv6 primeiro."
  while read -r ns; do echo "nameserver $ns"; done <<<"$NAMESERVERS"
)

put_file "$DROPIN" 0644 <<EOF
# Gerado por infra/vm/10-install-k3s.sh (fiapx). Removido pelo 99-uninstall.sh.
[Unit]
# O kube-proxy só cria o NodePort em 172.18.0.1 se a bridge da rede "borda" já existir:
# subir depois do Docker (e da guarda raw) evita 502 no Caddy depois de um reboot.
After=docker.service fiapx-netguard.service
Wants=fiapx-netguard.service
# Se um dos discos em loop não montar, o K3s NÃO sobe (nunca escreve direto no "/").
RequiresMountsFor=$RANCHER $PV_DIR

[Service]
# Sem a guarda raw ativa, o K3s NÃO sobe (containers do Docker alcançariam pods e ClusterIPs).
# Falhou? O Restart=always do k3s.service tenta de novo a cada 5 s, e o fiapx-netguard também
# se repete (Restart=on-failure): quando a guarda ficar ativa, o K3s sobe sozinho.
# (Requires= também barraria a subida, mas NÃO tentaria de novo depois, e todo
# "systemctl restart fiapx-netguard" do 20-firewall.sh reiniciaria o K3s junto.)
ExecStartPre=/usr/bin/systemctl is-active --quiet fiapx-netguard.service
EOF

# ------------------------------------------------------------------ 6. instalador
step "6. Instalador oficial fixado em $K3S_VERSION"
if [[ $INSTALLED == "$K3S_VERSION" ]]; then done_ "k3s $K3S_VERSION instalado"
else
  inst=$STATE_DIR/install-$K3S_VERSION.sh
  info "O instalador baixa o binário da release e confere o sha256 publicado nela. Com"
  info "INSTALL_K3S_SKIP_START ele só instala e habilita o serviço; quem inicia é o passo 7."
  info "Ele NÃO sobrescreve o /usr/bin/ctr do Docker (pula comandos que já existem no PATH)."
  if (( APPLY )); then
    install -d -m 0700 "$STATE_DIR"
    curl -sfL --retry 3 -o "$inst" "$INSTALLER_URL" || die "download do instalador falhou: $INSTALLER_URL"
    info "instalador: $inst (sha256 $(sha256sum "$inst" | cut -c1-16)...)"
  else
    printf '    [dry-run] $ curl -sfL -o %s %s\n' "$inst" "$INSTALLER_URL"
  fi
  run env INSTALL_K3S_VERSION="$K3S_VERSION" INSTALL_K3S_SKIP_START=true INSTALL_K3S_EXEC=server sh "$inst"
fi
run systemctl daemon-reload

# ------------------------------------------------------------------ 7. start
step "7. Start"
if (( ! START )); then info "--no-start: K3s instalado e parado. Inicie com: systemctl start k3s"; exit 0; fi
if systemctl is-active --quiet k3s; then
  if (( ${#CHANGED[@]} )); then
    info "ATENÇÃO: o K3s está no ar e este run $( (( APPLY )) && echo alterou || echo alteraria ):"
    for f in "${CHANGED[@]}"; do info "  - $f"; done
    info "Eles só valem depois de: systemctl restart k3s   (pods seguem rodando; ~30 s sem apiserver)"
    info "Depois: ./00-preflight.sh --post"
  else
    done_ "k3s já ativo e sem mudança de configuração"
  fi
else
  run systemctl start k3s
fi
if (( APPLY )); then
  info "aguardando o apiserver e o nó (até 3 min)..."
  for _ in $(seq 1 90); do
    [[ $(k3s kubectl get --raw /readyz 2>/dev/null) == ok ]] \
      && k3s kubectl get nodes 2>/dev/null | matches ' Ready ' && break
    sleep 2
  done
  k3s kubectl get nodes -o wide | sed 's/^/    /' || die "o nó não ficou pronto; veja: journalctl -u k3s -n 200"
  info "aguardando coredns, local-path e metrics-server..."
  k3s kubectl -n kube-system rollout status deploy/coredns --timeout=180s | sed 's/^/    /'
  k3s kubectl -n kube-system rollout status deploy/local-path-provisioner --timeout=180s | sed 's/^/    /'
  k3s kubectl -n kube-system rollout status deploy/metrics-server --timeout=180s | sed 's/^/    /'
  echo -e "\nK3s no ar. Próximos passos: ./00-preflight.sh --post · ./30-ingress.sh"
else
  echo -e "\n(dry-run) Para aplicar: $0 --yes${SWAP_SIZE:+ --swap $SWAP_SIZE}"
fi
