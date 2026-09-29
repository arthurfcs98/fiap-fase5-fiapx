#!/usr/bin/env bash
# infra/vm/35-keda.sh — KEDA (autoscaling por eventos) via helm-controller do K3s.
#
# Uso (root, na VM, com o K3s no ar):
#   ./35-keda.sh                 dry-run: mostra o manifesto e o kubectl diff (padrão)
#   ./35-keda.sh --yes           instala/atualiza (idempotente) e confere operator + APIService
#   ./35-keda.sh --revert [--yes]  remove o HelmChart (o helm-controller desinstala) e o namespace keda
#
# O que aplica: k8s/keda-helmchart.yaml (Namespace keda + HelmChart com a versão do chart FIXADA).
# Por que KEDA: o HPA só enxerga CPU/memória; o video-worker escala pelo tamanho da fila
# worker.video-uploaded no RabbitMQ (ScaledObject no namespace fiapx, criado pelo deploy.sh).
#
# Na instalação de 2026-09-28 o arquivo foi aplicado à mão (kubectl apply -f). Rodar este script
# por cima converge o mesmo objeto: ele usa o mesmo "kubectl apply" (client-side), sem conflito de
# dono de campo com o que já está lá.
set -Eeuo pipefail
export LC_ALL=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR
readonly MANIFEST=$SCRIPT_DIR/k8s/keda-helmchart.yaml
readonly APISERVICE=v1beta1.external.metrics.k8s.io
readonly DEPLOYS=(keda-operator keda-operator-metrics-apiserver keda-admission-webhooks)

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
run() {
  if (( APPLY )); then printf '    $ %s\n' "$*"; "$@"
  else printf '    [dry-run] $ %s\n' "$*"; fi
}
k() { /usr/local/bin/k3s kubectl "$@"; }

[[ $EUID -eq 0 ]] || die "rode como root"
[[ -f $MANIFEST ]] || die "não achei $MANIFEST"
systemctl is-active --quiet k3s || die "k3s não está ativo"
[[ $(k get --raw /readyz 2>/dev/null) == ok ]] || die "apiserver não está pronto"
(( APPLY )) || echo "(dry-run: nada será alterado; use --yes para aplicar)"

if (( REVERT )); then
  step "Remover o KEDA"
  info "Antes: nenhum ScaledObject pode depender dele (o worker volta a ter réplicas fixas)."
  k -n fiapx get scaledobjects.keda.sh 2>/dev/null | sed 's/^/    /' || true
  if k -n kube-system get helmchart keda >/dev/null 2>&1; then
    run k -n kube-system delete helmchart keda --wait=true --timeout=300s   # o helm-controller roda o helm uninstall
  else done_ "HelmChart keda não existe"; fi
  if k get ns keda >/dev/null 2>&1; then run k delete ns keda --wait=true --timeout=180s; else done_ "namespace keda não existe"; fi
  # As CRDs do KEDA ficam (o Helm não apaga CRD). Apagar CRD apaga TODOS os ScaledObjects.
  info "CRDs *.keda.sh ficam de propósito; para tirar: k3s kubectl delete crd -l app.kubernetes.io/part-of=keda-operator"
  (( APPLY )) || echo -e "\n(dry-run) Para aplicar: $0 --revert --yes"
  exit 0
fi

step "1. Manifesto ($MANIFEST)"
grep -E '^\s+(version|chart|repo|targetNamespace):' "$MANIFEST" | sed 's/^ */    /'
if (( APPLY )); then
  k apply -f "$MANIFEST" | sed 's/^/    /'
else
  info "[dry-run] kubectl diff contra o cluster (vazio = nada a mudar):"
  k diff -f "$MANIFEST" 2>&1 | sed 's/^/        /' || true
  echo -e "\n(dry-run) Para aplicar: $0 --yes"
  exit 0
fi

step "2. Aguardar o helm-controller e os Deployments (até 5 min)"
for _ in $(seq 1 100); do
  k -n keda get deploy keda-operator >/dev/null 2>&1 && break
  sleep 3
done
k -n keda get deploy keda-operator >/dev/null 2>&1 \
  || { k -n kube-system logs job/helm-install-keda --tail=40 2>&1 | sed 's/^/    /'; die "o Deployment keda-operator não apareceu"; }
for d in "${DEPLOYS[@]}"; do
  k -n keda rollout status "deploy/$d" --timeout=300s | sed 's/^/    /'
done

step "3. APIService $APISERVICE (é por ela que o HPA gerado pelo KEDA lê a fila)"
ok=0
for _ in $(seq 1 40); do
  [[ $(k get apiservice "$APISERVICE" -o jsonpath='{.status.conditions[?(@.type=="Available")].status}' 2>/dev/null) == True ]] && { ok=1; break; }
  sleep 3
done
(( ok )) || die "APIService $APISERVICE indisponível: k3s kubectl -n keda logs deploy/keda-operator-metrics-apiserver"
info "APIService disponível"
k -n keda get pods -o wide | sed 's/^/    /'
echo -e "\nKEDA no ar. Os ScaledObjects vêm dos manifestos do app (infra/k8s), aplicados pelo deploy.sh."
