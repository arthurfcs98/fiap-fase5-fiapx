#!/usr/bin/env bash
# /opt/fiapx/bin/deploy.sh — fonte no repo: infra/vm/deploy.sh (instalado pelo 40-deployer-access.sh,
# root:root 0755). É o "forced command" da chave de deploy do GitHub Actions: o usuário fiapx-deploy
# (sem sudo, fora do grupo docker) só consegue rodar ISTO, com um destes pedidos:
#
#   deploy <sha40>   aplica o commit <sha40> da main, com as imagens sha-<7> fixadas por DIGEST
#   rollback         volta para a release anterior registrada (reaplica o manifesto dela)
#   status           mostra a release atual/anterior e o estado do namespace
#
# Uso local (operador, root):  runuser -u fiapx-deploy -- /opt/fiapx/bin/deploy.sh status
#
# Fluxo do deploy (o log sai no Actions e em $STATE/logs):
#   1 git fetch da main (repo público) -> exige SHA na main e recusa downgrade
#   2 GHCR anônimo -> digest de sha-<7> de cada app (falha se o pacote for privado ou não existir)
#   3 kubectl kustomize (overlay + images.digest; Jobs com sufixo -<sha7>)
#   4 apply --dry-run=server (RBAC, Pod Security, quota, schema) + kubectl diff (registrado)
#   5 camada de dados (label fiapx.io/tier=data) -> rollout dos StatefulSets
#   6 Jobs backup -> setup -> migrate
#   7 apply de tudo (server-side) -> rollout status (Deployments, StatefulSets, DaemonSets)
#   8 smoke interno: Host fiapx.asdevit.com -> 172.18.0.1:30080/api/health/ready
#   9 sucesso: registra a release | falha: reaplica releases/<atual>/rendered.yaml (rollback)
#
# Por que reaplicar o manifesto anterior e não "kubectl rollout undo": o undo volta uma revisão de
# CADA Deployment (inclusive dos que não mudaram) e não desfaz ConfigMap, HPA, Ingress nem
# ScaledObject. O schema do banco NUNCA é revertido (migrações expand/contract).
#
# Códigos de saída: 0 ok | 1 falhou (rollback feito, ou nada foi aplicado) | 2 pedido inválido
#                   3 falhou E o rollback falhou (intervir) | 4 downgrade recusado
#                   5 commit já marcado como ruim (falhou e foi revertido antes; nada foi aplicado)
#                   75 lock ocupado
# Commit ruim: todo SHA que falhou no apply (e foi revertido) ou que saiu por "rollback" vai para
# $STATE/bad. Um novo "deploy" desse SHA é recusado (5): assim a repetição do Actions depois de
# uma queda do SSH não refaz um deploy que acabou de falhar. Para liberar de propósito (root):
#   sed -i '/^<sha40>$/d' /var/lib/fiapx-deploy/state/bad
set -Eeuo pipefail
umask 027
export LC_ALL=C PATH=/usr/local/bin:/usr/bin:/bin

readonly REPO_URL=https://github.com/arthurfcs98/fiap-fase5-fiapx.git
readonly GHCR_OWNER=arthurfcs98
readonly APPS=(video-api video-worker notification-service)
readonly NS=fiapx
readonly PUBLIC_HOST=fiapx.asdevit.com
readonly INGRESS_URL=http://172.18.0.1:30080    # NodePort do Traefik, só no gateway da rede borda
readonly OVERLAY=infra/k8s/overlays/prod        # estado desejado do namespace (sem Secret/Namespace/RBAC)
readonly JOBS=infra/k8s/jobs                    # Jobs one-shot com label fiapx.io/phase=backup|setup|migrate
readonly HOME_DIR=/var/lib/fiapx-deploy
readonly STATE=$HOME_DIR/state
readonly KEEP_RELEASES=5
readonly ROLLOUT_TIMEOUT=900s                   # worker em Recreate espera até 720 s de grace do vídeo em curso
readonly JOB_TIMEOUT=300
readonly PART_OF=app.kubernetes.io/part-of=fiapx
readonly MANIFEST_TYPES='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'
SELF=$(readlink -f -- "${BASH_SOURCE[0]}")
readonly SELF

export KUBECONFIG=$HOME_DIR/kubeconfig KUBECACHEDIR=$STATE/kube-cache HOME=$STATE
# /usr/local/bin/kubectl é o binário multicall do K3s: ele tenta ler /etc/rancher/k3s/config.yaml
# (0600, só root) e, como fiapx-deploy, imprime 3 avisos "permission denied" por chamada. Esses
# avisos quebraram o 1º deploy (entraram na saída capturada como se fossem nomes de recurso).
# Um arquivo de config vazio e legível os elimina; o kubeconfig acima continua valendo.
export K3S_CONFIG_FILE=/dev/null
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null

ACTION='' SHA=''

log()  { printf '%s [%s] %s\n' "$(date -u +%FT%TZ)" "${ACTION:-?}" "$*"; }
note() { log "$*"; logger -t fiapx-deploy -- "${ACTION:-?} ${SHA:0:7} $*" 2>/dev/null || true; }
die()  { note "ERRO: $1"; exit "${2:-1}"; }
step() { log "==> $*"; }

kq()     { kubectl --namespace "$NS" --request-timeout=60s "$@"; }   # chamadas curtas
kapply() { kq apply --server-side --field-manager=fiapx-deploy --force-conflicts "$@"; }
# Nomes (kind/nome) de um arquivo que casam com um seletor. Saída vazia + status 0 se nada casar;
# status 1 se o kubectl falhar por outro motivo (API fora, arquivo inválido): o chamador NÃO pode
# confundir "falhou" com "não há nada" (pularia migração ou rollout sem conferir).
names_in() {
  local out err rc=0 errf
  errf=$(mktemp) || return 1
  # stdout e stderr SEPARADOS: só o stdout são nomes; um aviso no stderr nunca vira "recurso".
  out=$(kubectl create --dry-run=client -o name -f "$1" ${2:+-l "$2"} 2>"$errf") || rc=$?
  err=$(<"$errf"); rm -f "$errf"
  if (( rc == 0 )); then printf '%s\n' "$out"; return 0; fi
  [[ $err == *"no objects passed to create"* ]] && return 0
  log "kubectl falhou ao listar objetos de ${1##*/}${2:+ ($2)}: $err" >&2   # stderr: stdout é o resultado
  return 1
}

# ---------------------------------------------------------------- pedido
parse_request() {
  local req=$1
  (( ${#req} <= 64 )) || die "pedido longo demais (${#req} bytes)" 2
  if [[ $req =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
    ACTION=deploy SHA=${BASH_REMATCH[1]}
  elif [[ $req == rollback || $req == status ]]; then
    ACTION=$req
  else
    die "pedido inválido; aceitos: 'deploy <sha40>', 'rollback', 'status'" 2
  fi
}

# ---------------------------------------------------------------- execução destacada
# O worker roda em outra sessão, sem stdin/stdout ligados ao SSH. Se o runner cair ou o job
# for cancelado, o deploy (e um eventual rollback) vai até o fim; este processo só espelha o log.
spawn_and_stream() {
  local id logf pid rc=0
  mkdir -p "$STATE/logs"
  id=$(date -u +%Y%m%dT%H%M%SZ)-$ACTION${SHA:+-${SHA:0:7}}
  logf=$STATE/logs/$id.log
  env -u SSH_ORIGINAL_COMMAND FIAPX_DEPLOY_WORKER=1 \
    setsid nohup "$SELF" "$ACTION" ${SHA:+"$SHA"} </dev/null >"$logf" 2>&1 &
  pid=$!
  tail -n +1 -F --pid="$pid" "$logf" 2>/dev/null || true
  wait "$pid" || rc=$?
  exit "$rc"
}

worker() {
  mkdir -p "$STATE/releases" "$KUBECACHEDIR"
  exec 9>"$STATE/lock"
  flock -w 900 9 || die "outro deploy/rollback segurou o lock por 15 min" 75
  trap 'log "comando falhou na linha $LINENO"' ERR
  case $ACTION in
    deploy)   do_deploy ;;
    rollback) do_rollback ;;
  esac
}

# ---------------------------------------------------------------- etapas
fetch_source() {  # $1 dir da release, $2 release atual
  local src=$1/src current=$2
  step "baixando o commit ${SHA:0:7} de $REPO_URL"
  git init -q "$src"
  git -C "$src" remote add origin "$REPO_URL"
  git -C "$src" fetch -q --depth=100 --filter=blob:none origin '+refs/heads/main:refs/remotes/origin/main' \
    || die "git fetch falhou"
  git -C "$src" merge-base --is-ancestor "$SHA" origin/main 2>/dev/null \
    || die "$SHA não está entre os últimos 100 commits da main" 2
  if [[ -n $current && $current != "$SHA" && -z ${FIAPX_ALLOW_DOWNGRADE:-} ]] \
     && git -C "$src" merge-base --is-ancestor "$SHA" "$current" 2>/dev/null; then
    die "downgrade recusado: ${SHA:0:7} é anterior à release atual ${current:0:7} (use 'rollback')" 4
  fi
  git -C "$src" -c advice.detachedHead=false checkout -q "$SHA"
  [[ $(git -C "$src" rev-parse HEAD) == "$SHA" ]] || die "checkout não bate com $SHA"
  [[ -f $src/$OVERLAY/kustomization.yaml ]] || die "o commit não tem $OVERLAY/kustomization.yaml"
}

resolve_digests() {  # GHCR anônimo: só funciona com pacote público (é o que se quer)
  local rel=$1 app repo token digest tag=sha-${SHA:0:7}
  step "resolvendo digests das imagens $tag"
  : > "$rel/digests.env"
  for app in "${APPS[@]}"; do
    repo=$GHCR_OWNER/fiapx-$app
    token=$(curl -fsS --max-time 15 "https://ghcr.io/token?scope=repository:$repo:pull" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])') \
      || die "GHCR negou acesso anônimo a $repo (pacote privado ou inexistente?)"
    digest=$(curl -fsS --max-time 15 -I -H "Authorization: Bearer $token" -H "Accept: $MANIFEST_TYPES" \
      "https://ghcr.io/v2/$repo/manifests/$tag" | tr -d '\r' \
      | awk -F': ' 'tolower($1)=="docker-content-digest" {print $2}') || true
    [[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || die "imagem ghcr.io/$repo:$tag não encontrada (o job de imagens terminou?)"
    printf '%s=%s\n' "$app" "$digest" >> "$rel/digests.env"
    log "ghcr.io/$repo:$tag -> $digest"
  done
}

write_kustomization() {  # $1 dir, $2 caminho relativo do recurso, $3 nameSuffix opcional
  local app d
  mkdir -p "$1"
  {
    echo "apiVersion: kustomize.config.k8s.io/v1beta1"
    echo "kind: Kustomization"
    echo "resources:"
    echo "  - ../src/$2"
    if [[ -n ${3:-} ]]; then printf 'nameSuffix: "%s"\n' "$3"; fi   # entre aspas: -0123456 viraria número
    echo "images:"
    while IFS='=' read -r app d; do
      printf '  - name: ghcr.io/%s/fiapx-%s\n    digest: "%s"\n' "$GHCR_OWNER" "$app" "$d"
    done < "${1%/*}/digests.env"
  } > "$1/kustomization.yaml"
}

render() {
  local rel=$1 app d
  step "renderizando manifestos"
  write_kustomization "$rel/render" "$OVERLAY"
  kubectl kustomize "$rel/render" > "$rel/rendered.yaml" || die "kustomize falhou em $OVERLAY"
  : > "$rel/jobs.yaml"
  if [[ -f $rel/src/$JOBS/kustomization.yaml ]]; then
    write_kustomization "$rel/render-jobs" "$JOBS" "-${SHA:0:7}"
    kubectl kustomize "$rel/render-jobs" > "$rel/jobs.yaml" || die "kustomize falhou em $JOBS"
  else
    log "sem $JOBS no commit: nenhuma migração/setup nesta release"
  fi
  # Nome de imagem diferente no overlay faz o kustomize não trocar nada, sem aviso. Por isso a conferência.
  while IFS='=' read -r app d; do
    grep -q "ghcr.io/$GHCR_OWNER/fiapx-$app@$d" "$rel/rendered.yaml" \
      || die "o overlay não usa a imagem ghcr.io/$GHCR_OWNER/fiapx-$app"
  done < "$rel/digests.env"
  if grep -Eq "image: *ghcr.io/$GHCR_OWNER/[^@[:space:]]+$" "$rel/rendered.yaml" "$rel/jobs.yaml"; then
    die "há imagem do projeto sem digest nos manifestos"
  fi
}

wait_rollouts() {  # $1 kind, $2 seletor
  local r list
  # Listagem que falha (timeout da API, RBAC) NÃO pode virar "nada a esperar": seria um rollout
  # dado como conferido sem conferir. set -e não vale aqui (chamado dentro de if/||).
  list=$(kq get "$1" -l "$2" -o name) || { log "não consegui listar $1 ($2)"; return 1; }
  for r in $list; do
    log "aguardando $r"
    kubectl --namespace "$NS" rollout status "$r" --timeout="$ROLLOUT_TIMEOUT" || { diagnose "$r"; return 1; }
  done
}

wait_job() {
  local j=$1 conds end=$((SECONDS + JOB_TIMEOUT))
  log "aguardando $j"
  while (( SECONDS < end )); do
    conds=$(kq get "$j" -o 'jsonpath={range .status.conditions[?(@.status=="True")]}{.type}{" "}{end}') || return 1
    case " $conds" in
      *" Complete "*) log "$j concluído"; return 0 ;;
      *" Failed "*)   log "$j falhou"; return 1 ;;
    esac
    sleep 3
  done
  log "$j passou de ${JOB_TIMEOUT}s"
  return 1
}

run_jobs() {  # $1 dir da release, $2 fase
  local rel=$1 phase=$2 j names
  names=$(names_in "$rel/jobs.yaml" "fiapx.io/phase=$phase") || return 1
  [[ -n $names ]] || { log "fase $phase: nenhum job"; return 0; }
  step "jobs da fase $phase"
  for j in $names; do  # retry da mesma release: recria o que falhou, mantém o que já concluiu
    if [[ $(kq get "$j" --ignore-not-found -o 'jsonpath={.status.failed}') =~ ^[1-9] ]]; then
      kq delete "$j" --wait=true || return 1
    fi
  done
  kapply -f "$rel/jobs.yaml" -l "fiapx.io/phase=$phase" || return 1
  for j in $names; do
    wait_job "$j" || { diagnose "$j"; return 1; }
  done
}

# O log do deploy aparece no GitHub Actions de um repo PÚBLICO: o nome do nó (hostname da VM)
# nunca sai daqui. Tira a linha "Node:" do describe e o "assigned <pod> to <nó>" dos eventos.
redact_node() {
  sed -E -e 's/^([[:space:]]*Node:[[:space:]]*).*/\1<omitido>/' \
    -e 's/(assigned [^ ]+ to )[^ ]+/\1<nó>/'
}

diagnose() {
  log "--- diagnóstico de $1 ---"
  kq describe "$1" 2>&1 | tail -n 40 | redact_node || true
  kq logs "$1" --all-containers --tail=100 2>&1 || true
  kq get events --sort-by=.lastTimestamp 2>&1 | tail -n 15 | redact_node || true
}

smoke_internal() {
  local i code=000
  for i in $(seq 1 20); do
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: $PUBLIC_HOST" \
      "$INGRESS_URL/api/health/ready" || true)
    [[ $code == 200 ]] && break
    sleep 3
  done
  [[ $code == 200 ]] || { log "smoke interno: /api/health/ready respondeu $code pelo ingress"; return 1; }
  log "smoke interno ok (ingress, tentativa $i)"
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$PUBLIC_HOST:443:127.0.0.1" \
    "https://$PUBLIC_HOST/api/health/live" || true)
  if [[ $code == 200 ]]; then log "borda (Caddy) ok"
  else log "AVISO: borda (Caddy) respondeu $code; o smoke público do Actions decide"; fi
}

apply_and_verify() {  # chamado dentro de if: set -e não vale aqui, por isso todo passo tem || return 1
  local rel=$1 data
  data=$(names_in "$rel/rendered.yaml" fiapx.io/tier=data)          || return 1
  if [[ -n $data ]]; then
    step "camada de dados (fiapx.io/tier=data)"
    kapply -f "$rel/rendered.yaml" -l fiapx.io/tier=data >/dev/null || return 1
    wait_rollouts statefulset fiapx.io/tier=data                   || return 1
  fi
  run_jobs "$rel" backup                                           || return 1
  run_jobs "$rel" setup                                            || return 1
  run_jobs "$rel" migrate                                          || return 1
  step "estado desejado completo"
  kapply -f "$rel/rendered.yaml"                                   || return 1
  wait_rollouts deployment "$PART_OF"                              || return 1
  wait_rollouts statefulset "$PART_OF"                             || return 1
  wait_rollouts daemonset "$PART_OF"                               || return 1
  smoke_internal                                                   || return 1
}

reapply() {  # volta para uma release já registrada
  local rel=$STATE/releases/$1
  kapply -f "$rel/rendered.yaml" >/dev/null   || return 1
  wait_rollouts deployment "$PART_OF"          || return 1
  wait_rollouts statefulset "$PART_OF"         || return 1
  wait_rollouts daemonset "$PART_OF"           || return 1
  smoke_internal                               || return 1
}

record_release() {
  kq create configmap fiapx-release --from-literal=sha="$1" --from-literal=deployedAt="$(date -u +%FT%TZ)" \
    --dry-run=client -o yaml | kapply -f - >/dev/null || log "AVISO: não gravei o ConfigMap fiapx-release"
}

prune_releases() {
  local cur prev d
  cur=$(cat "$STATE/current" 2>/dev/null || true)
  prev=$(cat "$STATE/previous" 2>/dev/null || true)
  # shellcheck disable=SC2012
  ls -1dt "$STATE"/releases/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r d; do
    d=${d%/}
    [[ ${d##*/} == "$cur" || ${d##*/} == "$prev" ]] && continue
    rm -rf -- "$d"
  done
  find "$STATE/logs" -name '*.log' -mtime +30 -delete 2>/dev/null || true
}

# ---------------------------------------------------------------- ações
do_deploy() {
  # A tentativa é montada em work/ e só vira releases/<sha> depois do sucesso: releases/<atual>
  # (alvo do rollback) nunca é tocado por um deploy recusado ou que falhou.
  local rel=$STATE/work/$SHA current jobs
  current=$(cat "$STATE/current" 2>/dev/null || true)
  # Já falhou e foi revertido (ou saiu por rollback)? Não tenta de novo sozinho. Cobre a repetição
  # do Actions depois de "ssh 255" quando o worker da 1ª tentativa já tinha falhado e revertido.
  if [[ -f $STATE/bad ]] && grep -qxF -- "$SHA" "$STATE/bad"; then
    die "${SHA:0:7} está marcado como ruim (falhou e foi revertido, ou saiu por rollback); nada foi aplicado. Corrija com um commit novo ou, como root: sed -i '/^$SHA\$/d' $STATE/bad" 5
  fi
  note "deploy ${SHA:0:7} iniciado (atual: ${current:0:7})"
  rm -rf -- "$STATE/work"   # só um deploy por vez (lock); a tentativa anterior fica aqui até a próxima
  mkdir -p "$rel"

  fetch_source "$rel" "$current"
  resolve_digests "$rel"
  render "$rel"
  step "validação no servidor (RBAC, Pod Security, quota, schema)"
  # Objeto de outro namespace, Namespace, Secret, RBAC, quota ou CRD no overlay também caem aqui
  # (o CD não tem permissão para eles): quem aplica isso é o root (infra/vm/README.md, seção 6.6).
  kapply --dry-run=server -f "$rel/rendered.yaml" >/dev/null \
    || die "o API server recusou os manifestos (motivo acima); nada foi aplicado"
  jobs=$(names_in "$rel/jobs.yaml") || die "não consegui ler os Jobs renderizados; nada foi aplicado"
  if [[ -n $jobs ]]; then
    kapply --dry-run=server -f "$rel/jobs.yaml" >/dev/null \
      || die "o API server recusou os Jobs; nada foi aplicado"
  fi
  kq diff --server-side --field-manager=fiapx-deploy --force-conflicts -f "$rel/rendered.yaml" \
    > "$rel/diff.txt" 2>&1 || true
  log "diff: $(grep -c '^[+-] ' "$rel/diff.txt" || true) linhas alteradas (detalhes em $rel/diff.txt)"

  if ! apply_and_verify "$rel"; then
    note "FALHA no deploy ${SHA:0:7}"
    printf '%s\n' "$SHA" >> "$STATE/bad"
    if [[ -z $current || ! -f $STATE/releases/$current/rendered.yaml ]]; then
      die "sem release anterior para voltar; o namespace ficou como está" 1
    fi
    note "rollback automático para ${current:0:7}"
    reapply "$current" || die "ROLLBACK FALHOU: intervenção manual (logs em $STATE/logs)" 3
    record_release "$current"
    die "deploy ${SHA:0:7} revertido para ${current:0:7}" 1
  fi

  rm -rf -- "$STATE/releases/$SHA"
  mv -- "$rel" "$STATE/releases/$SHA"
  if [[ -n $current && $current != "$SHA" ]]; then printf '%s\n' "$current" > "$STATE/previous"; fi
  printf '%s\n' "$SHA" > "$STATE/current"
  record_release "$SHA"
  prune_releases
  note "deploy ${SHA:0:7} concluído"
}

do_rollback() {
  local cur prev
  cur=$(cat "$STATE/current" 2>/dev/null || true)
  prev=$(cat "$STATE/previous" 2>/dev/null || true)
  [[ -n $prev && -f $STATE/releases/$prev/rendered.yaml ]] || die "não há release anterior registrada"
  note "rollback ${cur:0:7} -> ${prev:0:7}"
  reapply "$prev" || die "rollback falhou; intervenção manual" 3
  printf '%s\n' "$prev" > "$STATE/current"
  rm -f -- "$STATE/previous"
  if [[ -n $cur ]]; then printf '%s\n' "$cur" >> "$STATE/bad"; fi
  record_release "$prev"
  note "rollback concluído; release atual ${prev:0:7}"
}

do_status() {
  printf 'atual:    %s\nanterior: %s\n' \
    "$(cat "$STATE/current" 2>/dev/null || echo -)" "$(cat "$STATE/previous" 2>/dev/null || echo -)"
  # Sem "-o wide": a coluna NODE traria o hostname da VM para o log público do Actions.
  kq get deploy,sts,ds,hpa,jobs,pods 2>&1 || true
  kq get scaledobjects.keda.sh 2>&1 || true
}

main() {
  if [[ -n ${FIAPX_DEPLOY_WORKER:-} ]]; then
    parse_request "$*"
    worker
    return
  fi
  if [[ -n ${SSH_ORIGINAL_COMMAND+x} ]]; then
    parse_request "$SSH_ORIGINAL_COMMAND"
  else
    parse_request "$*"
  fi
  if [[ $ACTION == status ]]; then do_status; return; fi
  spawn_and_stream
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
