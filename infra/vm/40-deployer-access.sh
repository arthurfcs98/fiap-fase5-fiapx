#!/usr/bin/env bash
# infra/vm/40-deployer-access.sh — acesso restrito do GitHub Actions à VM e ao cluster.
#
# Uso (root, na VM, com o K3s no ar):
#   ./40-deployer-access.sh --pubkey /root/fiapx_deploy.pub          dry-run (padrão)
#   ./40-deployer-access.sh --pubkey /root/fiapx_deploy.pub --yes    aplica (idempotente)
#   ./40-deployer-access.sh --yes                                    reaplica sem trocar a chave
#   ./40-deployer-access.sh --revert [--yes]                         remove usuário, chave e script
#
# A chave é gerada NO MAC (nunca na VM):  ssh-keygen -t ed25519 -N '' -C fiapx-deploy@github-actions -f fiapx_deploy
# Só a PÚBLICA (fiapx_deploy.pub) vem para a VM; a privada vai para o secret VM_SSH_KEY.
#
# O que cria:
#   1. no cluster (kubeconfig admin): k8s/namespace-guard.yaml, k8s/deployer-rbac.yaml e
#      k8s/observability-rbac.yaml (leitura para o Prometheus e o Alloy; o CD não cria RBAC)
#   2. usuário Linux fiapx-deploy: sem senha, sem sudo, FORA do grupo docker (docker = root)
#   3. /var/lib/fiapx-deploy/.ssh/authorized_keys (dono root) com
#        restrict,command="/opt/fiapx/bin/deploy.sh" <chave>
#      restrict = sem shell, pty, port/agent/X11 forwarding. O sshd_config NÃO muda.
#   4. /opt/fiapx/bin/deploy.sh (dono root; o usuário executa, não altera)
#   5. /var/lib/fiapx-deploy/kubeconfig com o token da ServiceAccount fiapx-deployer (só no namespace fiapx)
set -Eeuo pipefail
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

readonly USER_NAME=fiapx-deploy
readonly HOME_DIR=/var/lib/fiapx-deploy
readonly BIN_DIR=/opt/fiapx/bin
readonly DEPLOY_BIN=$BIN_DIR/deploy.sh
readonly NS=fiapx SA=fiapx-deployer TOKEN_SECRET=fiapx-deployer-token
readonly ADMIN_KUBECONFIG=/etc/rancher/k3s/k3s.yaml
readonly API_SERVER=https://127.0.0.1:6443
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR

APPLY=0 REVERT=0 PUBKEY_FILE=""
while (( $# )); do
  case $1 in
    --yes) APPLY=1 ;;
    --revert) REVERT=1 ;;
    --pubkey) PUBKEY_FILE=${2:?}; shift ;;
    -h|--help) sed -n '2,/^[^#]/{/^#/s/^# \{0,1\}//p;}' "$0"; exit 0 ;;
    *) echo "argumento desconhecido: $1 (use --help)" >&2; exit 2 ;;
  esac
  shift
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
k() { KUBECONFIG=$ADMIN_KUBECONFIG /usr/local/bin/kubectl "$@"; }
as_deployer() { runuser -u "$USER_NAME" -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp "$@"; }
# Pod de teste enviado com --dry-run=server (passa por toda a admissão: LimitRanger, Priority,
# PSA, ValidatingAdmissionPolicy, ResourceQuota) e NÃO é gravado. 0 = aceito; 1 = negado (motivo no stdout).
probe_pod() {  # probe_pod <priorityClassName|-> <request de memória> <limit de memória>
  local pc=$1 req=$2 lim=$3 out pcline=""
  [[ $pc == - ]] || pcline="priorityClassName: $pc"
  if out=$(k create --dry-run=server -n "$NS" -o name -f - 2>&1 <<EOF
apiVersion: v1
kind: Pod
metadata:
  generateName: fiapx-conformidade-
  labels: { app.kubernetes.io/part-of: fiapx }
spec:
  $pcline
  containers:
    - name: c
      image: registry.k8s.io/pause:3.10
      resources:
        requests: { cpu: 10m, memory: "$req" }
        limits: { cpu: 50m, memory: "$lim" }
EOF
  ); then return 0; fi
  printf '%s\n' "$out" | grep -vi 'warning' | head -n 1 | cut -c1-140
  return 1
}

[[ $EUID -eq 0 ]] || die "rode como root"
(( APPLY )) || echo "(dry-run: nada será alterado; use --yes para aplicar)"

# ------------------------------------------------------------------ reversão
if (( REVERT )); then
  step "Remover o acesso do CD"
  if id "$USER_NAME" >/dev/null 2>&1; then
    run pkill -u "$USER_NAME" || true
    run userdel "$USER_NAME"
  else done_ "usuário $USER_NAME não existe"; fi
  if [[ -e $HOME_DIR ]]; then run rm -rf -- "$HOME_DIR"; else done_ "$HOME_DIR não existe"; fi
  if [[ -e /opt/fiapx ]]; then run rm -rf -- /opt/fiapx; else done_ "/opt/fiapx não existe"; fi
  if systemctl is-active --quiet k3s 2>/dev/null; then
    run k delete -f "$SCRIPT_DIR/k8s/deployer-rbac.yaml" --ignore-not-found
    run k delete -f "$SCRIPT_DIR/k8s/observability-rbac.yaml" --ignore-not-found
    info "namespace-guard.yaml (namespace fiapx, quota, prioridades) fica: apague com"
    info "  k3s kubectl delete -f $SCRIPT_DIR/k8s/namespace-guard.yaml   (APAGA os dados do fiapx)"
  fi
  info "No GitHub: apague os secrets do environment production (VM_SSH_KEY, VM_KNOWN_HOSTS, VM_HOST)."
  exit 0
fi

# ------------------------------------------------------------------ pré-condições
step "0. Pré-condições"
systemctl is-active --quiet k3s || die "k3s não está ativo"
for f in k8s/namespace-guard.yaml k8s/deployer-rbac.yaml k8s/observability-rbac.yaml deploy.sh; do
  [[ -f $SCRIPT_DIR/$f ]] || die "não achei $SCRIPT_DIR/$f"
done
PUBKEY=""
if [[ -n $PUBKEY_FILE ]]; then
  [[ -f $PUBKEY_FILE ]] || die "não achei $PUBKEY_FILE"
  grep -q 'PRIVATE KEY' "$PUBKEY_FILE" && die "$PUBKEY_FILE é uma chave PRIVADA. Traga só o .pub para a VM."
  [[ $(grep -cv '^[[:space:]]*$' "$PUBKEY_FILE") -eq 1 ]] || die "$PUBKEY_FILE precisa ter exatamente uma linha"
  PUBKEY=$(grep -v '^[[:space:]]*$' "$PUBKEY_FILE")
  [[ $PUBKEY =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [[:print:]]*)?$ ]] || die "esperado uma chave pública ssh-ed25519"
  ssh-keygen -l -f "$PUBKEY_FILE" >/dev/null 2>&1 || die "ssh-keygen não reconhece $PUBKEY_FILE"
  info "chave: $(ssh-keygen -l -f "$PUBKEY_FILE")"
elif [[ ! -s $HOME_DIR/.ssh/authorized_keys ]]; then
  die "informe --pubkey <arquivo.pub> na primeira execução"
fi

# ------------------------------------------------------------------ 1. objetos do cluster
step "1. Namespace fiapx (guardas), RBAC do deployer e da observabilidade (kubeconfig admin)"
for f in namespace-guard.yaml deployer-rbac.yaml observability-rbac.yaml; do
  if (( APPLY )); then
    k apply --server-side --field-manager=fiapx-infra -f "$SCRIPT_DIR/k8s/$f" | sed 's/^/    /'
  else
    info "[dry-run] kubectl diff -f k8s/$f:"
    k diff --server-side --field-manager=fiapx-infra -f "$SCRIPT_DIR/k8s/$f" 2>&1 | sed 's/^/        /' || true
  fi
done

# ------------------------------------------------------------------ 2. usuário Linux
step "2. Usuário $USER_NAME (sem senha, sem sudo, fora do grupo docker)"
if id "$USER_NAME" >/dev/null 2>&1; then done_ "usuário existe: $(id "$USER_NAME")"
else
  run useradd --system --home-dir "$HOME_DIR" --no-create-home --shell /bin/sh "$USER_NAME"
fi
# "*" (e não "!"): senha impossível sem marcar a conta como bloqueada, que faria o sshd recusar a chave.
run usermod -p '*' "$USER_NAME"
if id -nG "$USER_NAME" 2>/dev/null | matches -Ew 'docker|sudo|adm|lxd'; then
  die "$USER_NAME está em grupo privilegiado ($(id -nG "$USER_NAME")); remova antes"
fi
# HOME do root (o usuário lê, não escreve): ele não consegue trocar o próprio .ssh nem o kubeconfig.
run install -d -o root -g "$USER_NAME" -m 0750 "$HOME_DIR"
run install -d -o "$USER_NAME" -g "$USER_NAME" -m 0750 "$HOME_DIR/state"
run install -d -o root -g root -m 0755 "$HOME_DIR/.ssh"

# ------------------------------------------------------------------ 3. authorized_keys
step "3. authorized_keys com forced command"
if [[ -n $PUBKEY ]]; then
  line="restrict,command=\"$DEPLOY_BIN\" $PUBKEY"
  if [[ -f $HOME_DIR/.ssh/authorized_keys ]] && grep -qxF -- "$line" "$HOME_DIR/.ssh/authorized_keys"; then done_ "chave já autorizada"
  elif (( APPLY )); then
    printf '%s\n' "$line" | install -o root -g root -m 0644 /dev/stdin "$HOME_DIR/.ssh/authorized_keys"
    info "gravado $HOME_DIR/.ssh/authorized_keys (a linha anterior, se havia, foi substituída: rotação)"
  else
    info "[dry-run] $HOME_DIR/.ssh/authorized_keys (root:root 0644):"
    info "    restrict,command=\"$DEPLOY_BIN\" ${PUBKEY:0:40}..."
  fi
else done_ "mantendo a chave atual"; fi

# ------------------------------------------------------------------ 4. deploy.sh
step "4. $DEPLOY_BIN (dono root; atualizar = rodar este script de novo)"
run install -d -o root -g root -m 0755 /opt/fiapx "$BIN_DIR"
if [[ -f $DEPLOY_BIN ]] && cmp -s "$SCRIPT_DIR/deploy.sh" "$DEPLOY_BIN"; then done_ "$DEPLOY_BIN atualizado"
else run install -o root -g root -m 0755 "$SCRIPT_DIR/deploy.sh" "$DEPLOY_BIN"; fi

# ------------------------------------------------------------------ 5. kubeconfig da ServiceAccount
step "5. kubeconfig da ServiceAccount $SA (só o namespace $NS)"
if (( APPLY )); then
  for _ in $(seq 1 30); do   # o token controller preenche o Secret em ~1 s
    [[ -n $(k -n "$NS" get secret "$TOKEN_SECRET" -o 'jsonpath={.data.token}' 2>/dev/null) ]] && break
    sleep 1
  done
  tmp=$(mktemp -d); chmod 700 "$tmp"; trap 'rm -rf "$tmp"' EXIT
  k -n "$NS" get secret "$TOKEN_SECRET" -o 'jsonpath={.data.ca\.crt}' | base64 -d > "$tmp/ca.crt"
  k -n "$NS" get secret "$TOKEN_SECRET" -o 'jsonpath={.data.token}'  | base64 -d > "$tmp/token"
  [[ -s $tmp/token && -s $tmp/ca.crt ]] || die "o token da ServiceAccount não foi emitido"
  K=(/usr/local/bin/kubectl --kubeconfig="$tmp/config")
  "${K[@]}" config set-cluster fiapx-k3s --server="$API_SERVER" --certificate-authority="$tmp/ca.crt" --embed-certs=true >/dev/null
  "${K[@]}" config set-credentials "$SA" --token="$(cat "$tmp/token")" >/dev/null
  "${K[@]}" config set-context fiapx --cluster=fiapx-k3s --user="$SA" --namespace="$NS" >/dev/null
  "${K[@]}" config use-context fiapx >/dev/null
  if [[ -f $HOME_DIR/kubeconfig ]] && cmp -s "$tmp/config" "$HOME_DIR/kubeconfig"; then done_ "$HOME_DIR/kubeconfig"
  else install -o root -g "$USER_NAME" -m 0640 "$tmp/config" "$HOME_DIR/kubeconfig"; info "gravado $HOME_DIR/kubeconfig (root:$USER_NAME 0640)"; fi
else
  info "[dry-run] ler token e CA do Secret $NS/$TOKEN_SECRET e gravar $HOME_DIR/kubeconfig (root:$USER_NAME 0640, servidor $API_SERVER)"
fi

# ------------------------------------------------------------------ 6. conferência
step "6. Conferência"
if (( APPLY )); then
  fails=0
  # "recurso/nome" no can-i é NOME de objeto; subrecurso vai em --subresource.
  for q in "create deployments -n fiapx:yes" "patch statefulsets -n fiapx:yes" "patch daemonsets -n fiapx:yes" \
           "get secrets -n fiapx:no" "create deployments -n kube-system:no" "create pods -n fiapx:no" \
           "create pods --subresource=exec -n fiapx:no" "patch resourcequotas -n fiapx:no" \
           "create rolebindings -n fiapx:no" "create namespaces:no"; do
    expect=${q##*:}; q=${q%:*}
    # shellcheck disable=SC2086
    got=$(as_deployer KUBECONFIG="$HOME_DIR/kubeconfig" kubectl auth can-i $q 2>/dev/null || true)
    verdict=ok
    [[ $got == "$expect" ]] || { verdict="ESPERADO $expect"; fails=$((fails + 1)); }
    printf '    %-40s %-4s %s\n' "$q" "$got" "$verdict"
  done
  # Admissão do namespace (pods de teste em dry-run, nada é criado): classes de prioridade do
  # sistema e pod Guaranteed precisam ser NEGADOS; o controle positivo precisa ser ACEITO.
  for c in "system-node-critical 32Mi 64Mi negado" "system-cluster-critical 32Mi 64Mi negado" \
           "- 64Mi 64Mi negado" "fiapx-app 32Mi 64Mi aceito"; do
    expect=${c##* }; c=${c% *}
    # shellcheck disable=SC2086  # "classe req lim" vira 3 argumentos
    if why=$(probe_pod $c); then got=aceito; else got=negado; fi
    verdict=ok
    [[ $got == "$expect" ]] || { verdict="ESPERADO $expect"; fails=$((fails + 1)); }
    printf '    pod de teste [%-32s] %-7s %s\n' "$c" "$got" "$verdict"
    if [[ $got == negado && -n $why ]]; then printf '        %s\n' "$why"; fi
  done
  # ServiceAccounts da observabilidade (criadas pelo deploy a partir de infra/k8s/; o RBAC já vale antes).
  for q in "prometheus:list pods -n fiapx:yes" "prometheus:get nodes --subresource=metrics:yes" \
           "prometheus:get secrets -n fiapx:no" "prometheus:list pods -n kube-system:no" \
           "alloy:get pods --subresource=log -n fiapx:yes" "alloy:get pods --subresource=log -n kube-system:no" \
           "alloy:get secrets -n fiapx:no"; do
    expect=${q##*:}; q=${q%:*}; sa=${q%%:*}; q=${q#*:}
    # shellcheck disable=SC2086
    got=$(k auth can-i $q --as="system:serviceaccount:$NS:$sa" 2>/dev/null || true)
    verdict=ok
    [[ $got == "$expect" ]] || { verdict="ESPERADO $expect"; fails=$((fails + 1)); }
    printf '    %-40s %-4s %s\n' "$sa: $q" "$got" "$verdict"
  done
  k -n "$NS" get resourcequota fiapx-sem-prioridade-de-sistema >/dev/null 2>&1 \
    || { info "quota fiapx-sem-prioridade-de-sistema AUSENTE"; fails=$((fails + 1)); }
  rc=0; as_deployer SSH_ORIGINAL_COMMAND='id; cat /etc/shadow' "$DEPLOY_BIN" >/dev/null 2>&1 || rc=$?
  if [[ $rc == 2 ]]; then info "forced command recusa 'id; cat /etc/shadow' (rc=2): ok"
  else info "forced command devolveu rc=$rc para um pedido inválido (esperado 2)"; fails=$((fails + 1)); fi
  as_deployer SSH_ORIGINAL_COMMAND=status "$DEPLOY_BIN" 2>&1 | sed 's/^/    /' || true
  (( fails == 0 )) || die "$fails conferência(s) falharam"
fi

step "7. Dados para o GitHub (environment 'production', secrets de ENVIRONMENT)"
info "VM_HOST        = $(ip -4 -o route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
info "VM_KNOWN_HOSTS = $(awk -v ip="$(ip -4 -o route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')" '{print ip, $1, $2}' /etc/ssh/ssh_host_ed25519_key.pub)"
info "                 (fingerprint: $(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}'))"
info "VM_SSH_KEY     = conteúdo do arquivo PRIVADO fiapx_deploy (no Mac). Depois apague a cópia local."
info "Teste do Mac:  ssh -i fiapx_deploy fiapx-deploy@<VM_HOST> status   (deve mostrar o estado)"
info "               ssh -i fiapx_deploy fiapx-deploy@<VM_HOST> id       (deve ser recusado, rc=2)"
(( APPLY )) || echo -e "\n(dry-run) Para aplicar: $0 ${PUBKEY_FILE:+--pubkey $PUBKEY_FILE }--yes"
