#!/usr/bin/env bash
# =============================================================================
# infra/k8s/scripts/bootstrap-secrets.sh — cria os Secrets do namespace fiapx.
#
# Roda UMA VEZ por cluster, como root na VM (kubeconfig admin do K3s), antes do primeiro
# deploy; e de novo sempre que um Secret novo aparecer nos manifestos (ele só completa o que
# falta). O CD (deploy.sh) não consegue criar nem ler Secrets, de propósito.
#
#   ./bootstrap-secrets.sh                                   # dry-run: mostra o plano
#   ./bootstrap-secrets.sh --yes                             # cria o que falta
#   ./bootstrap-secrets.sh --yes --resend-key-file /root/resend.key   # + chave do Resend
#
# Regras (iguais às dos scripts do SRE em infra/vm):
#   - dry-run por padrão; nada muda sem --yes;
#   - idempotente: Secret que já existe NÃO é regenerado. Se faltar só uma chave, ela é
#     acrescentada. Valores compostos (RABBITMQ_URL, REDIS_URL, host do KEDA, DB_PASSWORD dos
#     apps) são montados a partir dos Secrets de base que já existem, então tudo fica coerente;
#   - nenhum segredo aparece na tela, em argumento de processo ou no git: os valores são
#     gerados com openssl direto para arquivos num diretório temporário 0700 (apagado no fim) e
#     entram no cluster por "kubectl create secret --from-file";
#   - no fim, confere se os valores repetidos entre Secrets batem (ex.: a senha do banco no
#     fiapx-postgres e no fiapx-video-api) e mostra só OK/DIVERGENTE.
#
# Variáveis: KUBECTL (padrão "kubectl"; na VM também serve "k3s kubectl"), NAMESPACE (fiapx).
# Rotação de um segredo: infra/k8s/README.md, seção "Segredos".
# =============================================================================
set -Eeuo pipefail
umask 077
export LC_ALL=C

NS=${NAMESPACE:-fiapx}
read -r -a KUBECTL <<< "${KUBECTL:-kubectl}"
YES=0
RESEND_KEY_FILE=''

usage() {
  sed -n '2,/^# =====/p' "$0" | sed -e 's/^# \{0,1\}//' -e '/^=====/d'
  exit "${1:-0}"
}

while (($#)); do
  case $1 in
    --yes) YES=1 ;;
    --namespace) NS=${2:?}; shift ;;
    --resend-key-file) RESEND_KEY_FILE=${2:?}; shift ;;
    -h|--help) usage 0 ;;
    *) echo "argumento desconhecido: $1" >&2; usage 2 ;;
  esac
  shift
done

log()  { printf '%s\n' "$*"; }
die()  { printf 'ERRO: %s\n' "$*" >&2; exit 1; }
k()    { "${KUBECTL[@]}" --namespace "$NS" "$@"; }

for bin in openssl base64 cmp; do
  command -v "$bin" >/dev/null || die "falta o comando $bin"
done
"${KUBECTL[@]}" version --client >/dev/null 2>&1 || die "kubectl indisponível (KUBECTL=${KUBECTL[*]})"
k get namespace "$NS" >/dev/null 2>&1 \
  || die "namespace $NS não existe (o root aplica infra/vm/k8s/namespace-guard.yaml antes)"
if [[ -n $RESEND_KEY_FILE ]]; then
  [[ -r $RESEND_KEY_FILE ]] || die "não consigo ler $RESEND_KEY_FILE"
fi

WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"' EXIT
VAL=$WORK/val
mkdir -m 0700 "$VAL"

# ---------------------------------------------------------------- valores
secret_exists() { k get secret "$1" >/dev/null 2>&1; }

# Copia a chave $2 do Secret $1 para o arquivo $3. Falha (1) se o Secret ou a chave não existem.
fetch_key() {
  local data
  data=$(k get secret "$1" -o "jsonpath={.data.$2}" 2>/dev/null) || return 1
  [[ -n $data ]] || return 1
  printf '%s' "$data" | base64 -d > "$3"
}

generate() {  # $1 formato, $2 arquivo
  case $1 in
    hex24) openssl rand -hex 24 | tr -d '\n' > "$2" ;;          # senhas/tokens: 48 hex, seguros em URL
    hex32) openssl rand -hex 32 | tr -d '\n' > "$2" ;;          # 32 bytes (JWT, RPC do Garage, S3)
    garage-key-id) { printf 'GK'; openssl rand -hex 12 | tr -d '\n'; } > "$2" ;;   # formato do Garage
    *) die "formato desconhecido: $1" ;;
  esac
}

# Valor de base: vem do Secret onde ele "mora" (se existir) ou é gerado agora.
#   base <NOME> <secret> <chave> <formato>
base() {
  local name=$1 secret=$2 key=$3 format=$4 file=$VAL/$1
  if fetch_key "$secret" "$key" "$file"; then
    printf '%s\n' "$name" >> "$WORK/reused"
  else
    generate "$format" "$file"
    printf '%s\n' "$name" >> "$WORK/generated"
  fi
}
touch "$WORK/reused" "$WORK/generated"

base POSTGRES_PASSWORD        fiapx-postgres       POSTGRES_PASSWORD        hex24
base VIDEO_DB_PASSWORD        fiapx-postgres       VIDEO_DB_PASSWORD        hex24
base NOTIF_DB_PASSWORD        fiapx-postgres       NOTIF_DB_PASSWORD        hex24
base RABBITMQ_PASSWORD        fiapx-rabbitmq       RABBITMQ_DEFAULT_PASS    hex24
base REDIS_PASSWORD           fiapx-redis          REDIS_PASSWORD           hex24
base GARAGE_RPC_SECRET        fiapx-garage         GARAGE_RPC_SECRET        hex32
base GARAGE_ADMIN_TOKEN       fiapx-garage         GARAGE_ADMIN_TOKEN       hex24
base GARAGE_METRICS_TOKEN     fiapx-garage         GARAGE_METRICS_TOKEN     hex24
base API_ACCESS_KEY_ID        fiapx-garage         API_ACCESS_KEY_ID        garage-key-id
base API_SECRET_ACCESS_KEY    fiapx-garage         API_SECRET_ACCESS_KEY    hex32
base WORKER_ACCESS_KEY_ID     fiapx-garage         WORKER_ACCESS_KEY_ID     garage-key-id
base WORKER_SECRET_ACCESS_KEY fiapx-garage         WORKER_SECRET_ACCESS_KEY hex32
base METRICS_TOKEN            fiapx-metrics        METRICS_TOKEN            hex24
base KEDA_PASSWORD            fiapx-keda-rabbitmq  KEDA_PASSWORD            hex24
base GRAFANA_PASSWORD         fiapx-grafana        admin-password           hex24
base JWT_SECRET               fiapx-video-api      JWT_SECRET               hex32
base DOWNLOAD_URL_SECRET      fiapx-video-api      DOWNLOAD_URL_SECRET      hex32

# Valores compostos (printf é builtin: o segredo não vira argumento de processo).
compose() {  # $1 nome, $2 formato do printf, $3 valor de base
  local secret
  secret=$(< "$VAL/$3")
  # shellcheck disable=SC2059   # o formato é fixo, definido abaixo
  printf "$2" "$secret" > "$VAL/$1"
}
compose RABBITMQ_URL 'amqp://fiapx:%s@rabbitmq:5672' RABBITMQ_PASSWORD
compose REDIS_URL    'redis://:%s@redis:6379' REDIS_PASSWORD
# O KEDA roda no namespace keda: precisa do nome completo do Service.
compose KEDA_HOST    "http://fiapx-keda:%s@rabbitmq.$NS.svc.cluster.local:15672/" KEDA_PASSWORD
printf '%s' admin > "$VAL/GRAFANA_USER"

HAS_RESEND=0
if [[ -n $RESEND_KEY_FILE ]]; then
  tr -d '[:space:]' < "$RESEND_KEY_FILE" > "$VAL/RESEND_API_KEY"
  [[ -s $VAL/RESEND_API_KEY ]] || die "$RESEND_KEY_FILE está vazio"
  HAS_RESEND=1
elif fetch_key fiapx-notification-service RESEND_API_KEY "$VAL/RESEND_API_KEY"; then
  HAS_RESEND=1
fi

# ---------------------------------------------------------------- Secrets (chave=valor)
# Quem usa cada um: comentário ao lado. Nomes referenciados nos manifestos de infra/k8s.
SECRETS=(
  fiapx-postgres               # StatefulSet postgres (superusuário + senhas dos 2 bancos)
  fiapx-rabbitmq               # StatefulSet rabbitmq e Job rabbitmq-init
  fiapx-redis                  # Deployment redis
  fiapx-garage                 # StatefulSet garage, Job garage-init, Prometheus (metrics token)
  fiapx-metrics                # Prometheus (Bearer do /metrics dos 3 apps)
  fiapx-keda-rabbitmq          # TriggerAuthentication do worker e Job rabbitmq-init
  fiapx-grafana                # Grafana (admin)
  fiapx-video-api              # video-api e Job video-api-migrate
  fiapx-video-worker           # video-worker
  fiapx-notification-service   # notification-service e Job notification-migrate
)

spec() {  # chaves de cada Secret: <chave no Secret>=<valor>
  case $1 in
    fiapx-postgres) echo POSTGRES_PASSWORD=POSTGRES_PASSWORD VIDEO_DB_PASSWORD=VIDEO_DB_PASSWORD NOTIF_DB_PASSWORD=NOTIF_DB_PASSWORD ;;
    fiapx-rabbitmq) echo RABBITMQ_DEFAULT_PASS=RABBITMQ_PASSWORD ;;
    fiapx-redis) echo REDIS_PASSWORD=REDIS_PASSWORD ;;
    fiapx-garage) echo GARAGE_RPC_SECRET=GARAGE_RPC_SECRET GARAGE_ADMIN_TOKEN=GARAGE_ADMIN_TOKEN \
      GARAGE_METRICS_TOKEN=GARAGE_METRICS_TOKEN API_ACCESS_KEY_ID=API_ACCESS_KEY_ID \
      API_SECRET_ACCESS_KEY=API_SECRET_ACCESS_KEY WORKER_ACCESS_KEY_ID=WORKER_ACCESS_KEY_ID \
      WORKER_SECRET_ACCESS_KEY=WORKER_SECRET_ACCESS_KEY ;;
    fiapx-metrics) echo METRICS_TOKEN=METRICS_TOKEN ;;
    fiapx-keda-rabbitmq) echo KEDA_PASSWORD=KEDA_PASSWORD host=KEDA_HOST ;;
    fiapx-grafana) echo admin-user=GRAFANA_USER admin-password=GRAFANA_PASSWORD ;;
    fiapx-video-api) echo DB_PASSWORD=VIDEO_DB_PASSWORD RABBITMQ_URL=RABBITMQ_URL REDIS_URL=REDIS_URL \
      S3_ACCESS_KEY_ID=API_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY=API_SECRET_ACCESS_KEY \
      JWT_SECRET=JWT_SECRET DOWNLOAD_URL_SECRET=DOWNLOAD_URL_SECRET METRICS_TOKEN=METRICS_TOKEN ;;
    fiapx-video-worker) echo RABBITMQ_URL=RABBITMQ_URL S3_ACCESS_KEY_ID=WORKER_ACCESS_KEY_ID \
      S3_SECRET_ACCESS_KEY=WORKER_SECRET_ACCESS_KEY METRICS_TOKEN=METRICS_TOKEN ;;
    fiapx-notification-service)
      local keys='DB_PASSWORD=NOTIF_DB_PASSWORD RABBITMQ_URL=RABBITMQ_URL METRICS_TOKEN=METRICS_TOKEN'
      if ((HAS_RESEND)); then keys+=' RESEND_API_KEY=RESEND_API_KEY'; fi
      echo "$keys" ;;
    *) die "Secret desconhecido: $1" ;;
  esac
}

# ---------------------------------------------------------------- plano e aplicação
created=0 patched=0 diverged=0
mode=$([[ $YES == 1 ]] && echo "aplicando" || echo "dry-run (nada muda sem --yes)")
log "namespace $NS — $mode"
log ""

for secret in "${SECRETS[@]}"; do
  read -r -a pairs <<< "$(spec "$secret")"
  if ! secret_exists "$secret"; then
    keys=()
    args=()
    for pair in "${pairs[@]}"; do
      keys+=("${pair%%=*}")
      args+=("--from-file=${pair%%=*}=$VAL/${pair#*=}")
    done
    log "[criar]   $secret (${keys[*]})"
    if ((YES)); then
      "${KUBECTL[@]}" create secret generic "$secret" --namespace "$NS" "${args[@]}" \
        --dry-run=client -o yaml > "$WORK/$secret.yaml"
      "${KUBECTL[@]}" label --local -f "$WORK/$secret.yaml" -o yaml \
        app.kubernetes.io/part-of=fiapx app.kubernetes.io/managed-by=bootstrap-secrets \
        > "$WORK/$secret.labeled.yaml"
      k create -f "$WORK/$secret.labeled.yaml" >/dev/null
    fi
    created=$((created + 1))
    continue
  fi

  missing=()
  for pair in "${pairs[@]}"; do
    key=${pair%%=*} value=${pair#*=}
    if fetch_key "$secret" "$key" "$WORK/current"; then
      if ! cmp -s "$WORK/current" "$VAL/$value"; then
        log "[DIVERGE] $secret: $key não bate com o valor de base (${value}); nada foi alterado"
        diverged=$((diverged + 1))
      fi
    else
      missing+=("$key=$value")
    fi
  done
  if ((${#missing[@]} == 0)); then
    log "[ok]      $secret"
    continue
  fi
  log "[completar] $secret (+ ${missing[*]%%=*})"
  if ((YES)); then
    {
      printf '{"data":{'
      sep=''
      for pair in "${missing[@]}"; do
        printf '%s"%s":"%s"' "$sep" "${pair%%=*}" "$(base64 < "$VAL/${pair#*=}" | tr -d '\n')"
        sep=','
      done
      printf '}}'
    } > "$WORK/patch.json"
    k patch secret "$secret" --type merge --patch-file "$WORK/patch.json" >/dev/null
  fi
  patched=$((patched + 1))
done

log ""
log "valores reaproveitados de Secrets existentes: $(wc -l < "$WORK/reused" | tr -d ' '); gerados agora: $(wc -l < "$WORK/generated" | tr -d ' ')"
if ((HAS_RESEND == 0)); then
  log "AVISO: sem RESEND_API_KEY. Em produção (EMAIL_PROVIDER=resend) o notification-service não sobe"
  log "       sem ela: rode de novo com --resend-key-file <arquivo> (o overlay local usa EMAIL_PROVIDER=log)."
fi
if ((diverged > 0)); then
  log "ATENÇÃO: $diverged chave(s) divergente(s). Um Secret foi recriado sem os outros; veja a seção"
  log "         \"Segredos\" do infra/k8s/README.md (rotação) antes de continuar."
fi
if ((YES)); then
  log "pronto: $created criado(s), $patched completado(s)."
else
  log "plano: $created a criar, $patched a completar. Rode com --yes para aplicar."
fi
((diverged == 0))
