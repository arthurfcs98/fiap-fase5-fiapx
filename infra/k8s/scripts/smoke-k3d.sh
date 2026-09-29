#!/usr/bin/env bash
# =============================================================================
# infra/k8s/scripts/smoke-k3d.sh — teste de ponta a ponta dos manifestos num K3s local (k3d),
# com a MESMA versão de K3s da VM e as MESMAS grades do SRE. Nada toca a VM.
#
#   make images                          # imagens ghcr.io/arthurfcs98/fiapx-*:local (compose)
#   infra/k8s/scripts/smoke-k3d.sh       # cria o cluster, testa e apaga no fim
#   KEEP=1 infra/k8s/scripts/smoke-k3d.sh   # mantém o cluster (KUBECONFIG impresso no fim)
#
# Passos (espelham o deploy.sh + o que o root faz uma vez na VM):
#    1. k3d com rancher/k3s:v1.36.4-k3s1 (Traefik embutido do k3d faz o papel do Traefik da VM);
#    2. importa as imagens locais dos 3 apps;
#    3. root: infra/vm/k8s/namespace-guard.yaml, observability-rbac.yaml e keda-helmchart.yaml;
#    4. root: scripts/bootstrap-secrets.sh --yes;
#    5. deploy: camada de dados (tier=data) -> Jobs setup -> Jobs migrate -> resto -> rollouts;
#    6. smoke: /api/health/ready pelo Ingress, alvos e regras do Prometheus, logs no Loki com
#       correlationId, dashboards no Grafana, usuário do KEDA e ScaledObject pronto;
#    7. consumo real de CPU/memória por pod (kubectl top), para comparar com o orçamento.
# =============================================================================
set -Eeuo pipefail
export LC_ALL=C

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
K8S=$ROOT/infra/k8s
VM=$ROOT/infra/vm/k8s
CLUSTER=${CLUSTER:-fiapx-smoke}
K3S_IMAGE=${K3S_IMAGE:-rancher/k3s:v1.36.4-k3s1}
HTTP_PORT=${HTTP_PORT:-8081}
KEEP=${KEEP:-0}
NS=fiapx
APPS=(video-api video-worker notification-service)

WORK=$(mktemp -d)
export KUBECONFIG=$WORK/kubeconfig
PF_PIDS=()
CREATED=0

log()  { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
step() { printf '\n%s ==> %s\n' "$(date +%H:%M:%S)" "$*"; }
die()  { printf '%s ERRO: %s\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }
k()    { kubectl --namespace "$NS" "$@"; }

cleanup() {
  local rc=$?
  for pid in "${PF_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  if ((rc != 0)) && ((CREATED)); then
    log "falhou (rc=$rc): estado do namespace para diagnóstico"
    k get pods -o wide 2>&1 | tail -n 30 || true
    k get events --sort-by=.lastTimestamp 2>&1 | tail -n 25 || true
  fi
  if ((CREATED)) && [[ $KEEP != 1 ]]; then
    log "apagando o cluster $CLUSTER"
    k3d cluster delete "$CLUSTER" >/dev/null 2>&1 || true
    rm -rf -- "$WORK"
  elif ((CREATED)); then
    log "cluster mantido (KEEP=1): export KUBECONFIG=$KUBECONFIG ; apagar: k3d cluster delete $CLUSTER"
  fi
  exit "$rc"
}
trap cleanup EXIT

port_forward() {  # $1 recurso, $2 porta local, $3 porta remota
  k port-forward "$1" "$2:$3" >/dev/null 2>&1 &
  PF_PIDS+=($!)
  for _ in $(seq 1 30); do
    if curl -s -o /dev/null "http://127.0.0.1:$2/"; then return 0; fi
    sleep 1
  done
  die "port-forward de $1 não respondeu"
}

secret_value() { k get secret "$1" -o "jsonpath={.data.$2}" | base64 -d; }

# ---------------------------------------------------------------- 0. pré-requisitos
for bin in docker k3d kubectl curl jq; do command -v "$bin" >/dev/null || die "falta $bin"; done
docker info >/dev/null 2>&1 || die "Docker parado (OrbStack: open -a OrbStack)"
for app in "${APPS[@]}"; do
  docker image inspect "ghcr.io/arthurfcs98/fiapx-$app:local" >/dev/null 2>&1 \
    || die "imagem ghcr.io/arthurfcs98/fiapx-$app:local ausente: rode 'make images'"
done
k3d cluster list "$CLUSTER" >/dev/null 2>&1 && die "o cluster $CLUSTER já existe (k3d cluster delete $CLUSTER)"

# ---------------------------------------------------------------- 1-2. cluster e imagens
step "criando o k3d $CLUSTER ($K3S_IMAGE), porta $HTTP_PORT -> Traefik"
k3d cluster create "$CLUSTER" --image "$K3S_IMAGE" --servers 1 --agents 0 \
  -p "$HTTP_PORT:80@loadbalancer" --kubeconfig-update-default=false --wait --timeout 180s >/dev/null
CREATED=1
k3d kubeconfig write "$CLUSTER" --output "$KUBECONFIG" >/dev/null
kubectl wait --for=condition=Ready node --all --timeout=120s >/dev/null
log "nó pronto: $(kubectl get node -o jsonpath='{.items[0].status.nodeInfo.kubeletVersion}')"

step "importando as imagens dos apps"
images=()
for app in "${APPS[@]}"; do images+=("ghcr.io/arthurfcs98/fiapx-$app:local"); done
k3d image import -c "$CLUSTER" "${images[@]}" >/dev/null
log "ok: ${images[*]}"

# ---------------------------------------------------------------- 3. o que o root aplica
step "grades do SRE: namespace-guard, observability-rbac, KEDA"
kubectl apply -f "$VM/namespace-guard.yaml" >/dev/null
kubectl apply -f "$VM/observability-rbac.yaml" >/dev/null
kubectl apply -f "$VM/keda-helmchart.yaml" >/dev/null
for _ in $(seq 1 90); do
  [[ $(kubectl -n keda get deploy -o name 2>/dev/null | wc -l) -ge 3 ]] && break
  sleep 2
done
kubectl -n keda wait --for=condition=Available deploy --all --timeout=300s >/dev/null
kubectl wait --for=condition=Established crd/scaledobjects.keda.sh --timeout=60s >/dev/null
log "KEDA pronto"

# ---------------------------------------------------------------- 4. segredos
step "Secrets (bootstrap-secrets.sh --yes)"
KUBECTL=kubectl "$K8S/scripts/bootstrap-secrets.sh" --yes | sed 's/^/    /'

# ---------------------------------------------------------------- 5. deploy (como o deploy.sh)
step "renderizando overlays/local e jobs"
kubectl kustomize "$K8S/overlays/local" > "$WORK/rendered.yaml"
kubectl kustomize "$K8S/overlays/local/jobs" > "$WORK/jobs.yaml"
kubectl apply --server-side --dry-run=server -f "$WORK/rendered.yaml" >/dev/null
kubectl apply --server-side --dry-run=server -f "$WORK/jobs.yaml" >/dev/null
log "dry-run no servidor ok (PSA, quota, LimitRange, VAP, schema)"

step "camada de dados (fiapx.io/tier=data)"
kubectl apply --server-side --field-manager=fiapx-deploy -f "$WORK/rendered.yaml" -l fiapx.io/tier=data >/dev/null
for sts in $(k get statefulset -l fiapx.io/tier=data -o name); do
  k rollout status "$sts" --timeout=300s >/dev/null
  log "$sts pronto"
done

run_phase() {  # $1 fase
  local jobs
  jobs=$(kubectl create --dry-run=client -o name -f "$WORK/jobs.yaml" -l "fiapx.io/phase=$1" 2>/dev/null || true)
  [[ -n $jobs ]] || return 0
  kubectl apply --server-side --field-manager=fiapx-deploy -f "$WORK/jobs.yaml" -l "fiapx.io/phase=$1" >/dev/null
  for j in $jobs; do
    if ! k wait --for=condition=Complete "$j" --timeout=280s >/dev/null 2>&1; then
      k logs "$j" --tail=50 || true
      die "$j não concluiu"
    fi
    log "$j concluído: $(k logs "$j" --tail=1)"
  done
}

step "Jobs da fase setup"
run_phase setup

step "Jobs da fase migrate"
missing_migrate=()
for app in video-api notification-service; do
  if ! docker run --rm --entrypoint test "ghcr.io/arthurfcs98/fiapx-$app:local" -f dist/migrate.js 2>/dev/null; then
    missing_migrate+=("$app")
  fi
done
if ((${#missing_migrate[@]} > 0)); then
  log "AVISO: imagem sem dist/migrate.js (${missing_migrate[*]}): fase migrate PULADA."
  log "       Os Jobs *-migrate só funcionam quando o app tiver o entry migrate (ver infra/k8s/README.md)."
else
  run_phase migrate
fi

step "estado desejado completo + rollouts"
kubectl apply --server-side --field-manager=fiapx-deploy -f "$WORK/rendered.yaml" >/dev/null
for kind in deployment statefulset daemonset; do
  for r in $(k get "$kind" -l app.kubernetes.io/part-of=fiapx -o name); do
    if ! k rollout status "$r" --timeout=300s >/dev/null 2>&1; then
      k describe "$r" | tail -n 20 || true
      die "$r não ficou pronto"
    fi
    log "$r pronto"
  done
done

# ---------------------------------------------------------------- 6. smoke
step "smoke: API pelo Ingress (Traefik)"
code=000
for _ in $(seq 1 30); do
  code=$(curl -s -o "$WORK/ready.json" -w '%{http_code}' -H 'Host: fiapx.localhost' \
    "http://127.0.0.1:$HTTP_PORT/api/health/ready" || true)
  [[ $code == 200 ]] && break
  sleep 2
done
[[ $code == 200 ]] || die "/api/health/ready respondeu $code"
log "/api/health/ready 200: $(tr -d '\n' < "$WORK/ready.json" | cut -c1-160)"
CID="smoke-$(date +%s)"
for path in /api/health/live /api/nao-existe; do
  curl -s -o /dev/null -H 'Host: fiapx.localhost' -H "x-correlation-id: $CID" \
    "http://127.0.0.1:$HTTP_PORT$path" || true
done
log "requisições com x-correlation-id=$CID enviadas"

step "smoke: Prometheus"
port_forward svc/prometheus 19090 9090
sleep 20   # um ciclo de coleta (15 s) + avaliação das regras
curl -s http://127.0.0.1:19090/api/v1/targets > "$WORK/targets.json"
jq -r '.data.activeTargets | group_by(.labels.job)[] | "\(.[0].labels.job): \(map(.health) | join(","))"' "$WORK/targets.json" \
  | sed 's/^/    /'
rules=$(curl -s http://127.0.0.1:19090/api/v1/rules | jq '[.data.groups[].rules[]] | length')
log "regras carregadas: $rules (esperado: 26 = 18 de gravação + 8 alertas)"
[[ $rules == 26 ]] || die "número de regras inesperado"
down=$(jq -r '[.data.activeTargets[] | select(.health != "up") | "\(.labels.job)/\(.labels.pod // .labels.instance): \(.lastError)"] | join("\n")' "$WORK/targets.json")
if [[ -n $down ]]; then
  log "AVISO: alvos fora:"
  printf '    %s\n' "$down"
fi
for q in 'up{job="fiapx-services"}' 'rabbitmq_identity_info' 'container_memory_working_set_bytes{namespace="fiapx"}' 'keda_build_info'; do
  n=$(curl -s --data-urlencode "query=$q" http://127.0.0.1:19090/api/v1/query | jq '.data.result | length')
  log "séries de $q: $n"
done

step "smoke: Loki (logs pelo Alloy)"
port_forward svc/loki 13100 3100
found=0
for _ in $(seq 1 30); do
  labels=$(curl -s http://127.0.0.1:13100/loki/api/v1/labels | jq -r '.data // [] | join(",")')
  if [[ $labels == *app* && $labels == *level* ]]; then found=1; break; fi
  sleep 2
done
((found)) || die "Loki sem os rótulos app/level (labels: ${labels:-nenhum})"
log "rótulos no Loki: $labels"
apps=$(curl -s -G http://127.0.0.1:13100/loki/api/v1/label/app/values | jq -r '.data | join(",")')
log "apps com logs: $apps"
now=$(date +%s)
cid_hits=0
for _ in $(seq 1 20); do
  cid_hits=$(curl -s -G http://127.0.0.1:13100/loki/api/v1/query_range \
    --data-urlencode "query={namespace=\"fiapx\"} | correlationId=\"$CID\"" \
    --data-urlencode "start=$(( (now - 600) * 1000000000 ))" --data-urlencode "limit=20" \
    | jq '[.data.result[].values[]] | length')
  ((cid_hits > 0)) && break
  sleep 3
done
if ((cid_hits > 0)); then
  log "correlationId $CID encontrado no Loki (structured metadata): $cid_hits linha(s)"
else
  log "AVISO: nenhuma linha com correlationId=$CID (o app desta imagem loga acessos? ver docs/observabilidade.md)"
fi
labels_of_stream=$(curl -s -G http://127.0.0.1:13100/loki/api/v1/series --data-urlencode 'match[]={namespace="fiapx"}' \
  --data-urlencode "start=$(( (now - 600) * 1000000000 ))" | jq -r '[.data[] | keys[]] | unique | join(",")')
log "rótulos dos streams: $labels_of_stream"
[[ $labels_of_stream == "app,level,namespace" ]] \
  || die "rótulos do Loki diferentes de app,level,namespace (cardinalidade; correlationId nunca é rótulo)"
meta=$(curl -s -G http://127.0.0.1:13100/loki/api/v1/query_range \
  --data-urlencode 'query={namespace="fiapx", app="video-api"}' --data-urlencode 'limit=1' \
  --data-urlencode "start=$(( (now - 600) * 1000000000 ))" -H 'X-Loki-Response-Encoding-Flags: categorize-labels' \
  | jq -r '.data.result[0].values[0][2].structuredMetadata // {} | keys | join(",")')
log "structured metadata de uma linha do video-api: $meta"

step "smoke: Grafana"
port_forward svc/grafana 13000 3000
gpass=$(secret_value fiapx-grafana admin-password)
ghealth=0
for _ in $(seq 1 30); do
  curl -sf -m 5 http://127.0.0.1:13000/api/health >/dev/null && { ghealth=1; break; }
  sleep 2
done
((ghealth)) || die "Grafana /api/health não respondeu em 60 s"
dashboards=$(curl -s -u "admin:$gpass" 'http://127.0.0.1:13000/api/search?type=dash-db' | jq -r '[.[].title] | join(" | ")')
log "dashboards: $dashboards"
[[ $dashboards == *"FIAP X — Pipeline de vídeos"* && $dashboards == *"FIAP X — SLOs"* ]] || die "dashboards ausentes"
datasources=$(curl -s -u "admin:$gpass" http://127.0.0.1:13000/api/datasources | jq -r '[.[].name] | join(",")')
log "datasources: $datasources"
for uid in prometheus loki; do
  st=$(curl -s -u "admin:$gpass" "http://127.0.0.1:13000/api/datasources/uid/$uid/health" | jq -r '.status // .message')
  log "datasource $uid: $st"
done
unset gpass

step "smoke: RabbitMQ, KEDA e Garage"
port_forward svc/rabbitmq 15673 15672
rpass=$(secret_value fiapx-rabbitmq RABBITMQ_DEFAULT_PASS)
tags=$(curl -s -u "fiapx:$rpass" http://127.0.0.1:15673/api/users/fiapx-keda | jq -r '.tags | if type == "array" then join(",") else . end')
log "usuário fiapx-keda: tags=$tags"
queues=$(curl -s -u "fiapx:$rpass" 'http://127.0.0.1:15673/api/queues/%2F?columns=name' | jq 'length')
log "filas no vhost /: $queues"
policy=$(curl -s -u "fiapx:$rpass" http://127.0.0.1:15673/api/operator-policies/%2F/fiapx-limits | jq -c '.definition')
log "operator policy fiapx-limits: $policy"
# Escala pelo KEDA: com a fila sem consumidor (imagem de esqueleto), 3 mensagens na fila
# levam o HPA do KEDA a 2 réplicas. Com o worker de verdade consumindo, o teste é pulado (as
# mensagens seriam consumidas antes da leitura do KEDA).
Q=http://127.0.0.1:15673/api/queues/%2F/worker.video-uploaded
consumers=$(curl -s -u "fiapx:$rpass" "$Q" | jq -r '.consumers // "ausente"')
if [[ $consumers == ausente || $consumers == 0 ]]; then
  if [[ $consumers == ausente ]]; then
    # Mesmos argumentos do contrato (seção 2): o serviço de verdade declara igual depois.
    curl -s -o /dev/null -u "fiapx:$rpass" -X PUT -H 'content-type: application/json' "$Q" -d '{"durable":true,
      "arguments":{"x-queue-type":"quorum","x-delivery-limit":5,"x-dead-letter-exchange":"fiapx.dlx",
      "x-dead-letter-routing-key":"worker.video-uploaded","x-dead-letter-strategy":"at-least-once",
      "x-overflow":"reject-publish"}}'
  fi
  for _ in 1 2 3; do
    curl -s -o /dev/null -u "fiapx:$rpass" -X POST -H 'content-type: application/json' \
      'http://127.0.0.1:15673/api/exchanges/%2F/amq.default/publish' \
      -d '{"properties":{},"routing_key":"worker.video-uploaded","payload":"{}","payload_encoding":"string"}'
  done
  scaled=0
  for _ in $(seq 1 30); do
    [[ $(k get deploy video-worker -o jsonpath='{.spec.replicas}') == 2 ]] && { scaled=1; break; }
    sleep 5
  done
  ((scaled)) || die "KEDA não escalou o video-worker para 2 com 3 mensagens na fila"
  k rollout status deploy/video-worker --timeout=180s >/dev/null
  log "KEDA: 3 mensagens na fila -> video-worker com 2 réplicas prontas"
else
  log "KEDA: fila com $consumers consumidor(es); teste de escala pulado"
fi
unset rpass
kpass=$(secret_value fiapx-keda-rabbitmq KEDA_PASSWORD)
kq=$(curl -s -o /dev/null -w '%{http_code}' -u "fiapx-keda:$kpass" 'http://127.0.0.1:15673/api/queues/%2F/worker.video-uploaded')
log "fiapx-keda lendo worker.video-uploaded pela API: HTTP $kq (404 = fila ainda não declarada pelos serviços)"
unset kpass
so=$(k get scaledobject video-worker -o jsonpath='{range .status.conditions[*]}{.type}={.status} {end}')
log "ScaledObject video-worker: $so"
log "HPA gerado pelo KEDA: $(k get hpa keda-hpa-video-worker -o jsonpath='{.spec.minReplicas}-{.spec.maxReplicas} réplicas' 2>/dev/null || echo ausente)"
log "garage-init: $(k logs -l app.kubernetes.io/name=garage-init --tail=3 2>/dev/null | tr '\n' ' ')"

# ---------------------------------------------------------------- 7. consumo real
step "consumo real (kubectl top, depois de ~1 min no ar)"
for _ in $(seq 1 30); do
  k top pods >/dev/null 2>&1 && break
  sleep 3
done
k top pods --containers 2>/dev/null | sed 's/^/    /' || log "(metrics-server ainda sem dados)"
# shellcheck disable=SC2016   # $k/$v são variáveis do go-template, não do shell
log "quota em uso: $(k get resourcequota fiapx-teto -o go-template='{{range $k, $v := .status.used}}{{$k}}={{$v}} {{end}}')"

step "OK: smoke do k3d concluído"
