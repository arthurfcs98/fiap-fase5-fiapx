#!/usr/bin/env bash
# =============================================================================
# Smoke do stack do compose (local e CI). Pré-requisito: `docker compose up -d --wait`.
# Confere: health dos 3 apps, versão de build, correlation id, token do /metrics (status
# HTTP exato), ffmpeg só no worker e os buckets/chave criados pelo garage-init.
#
# Variáveis: as já exportadas no shell GANHAM do .env (mesma precedência do Compose), então
# `APP_VERSION=sha-abc1234 ./scripts/compose-smoke.sh` confere a imagem certa.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Lê o .env como KEY=VALUE (sem executar nada): só define chaves ainda não definidas no
# ambiente e remove aspas simples/duplas externas, como o Compose faz.
load_env_defaults() {
  local file="$1" line key value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    [[ -n "${!key+x}" ]] && continue
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    export "$key=$value"
  done < "$file"
}
load_env_defaults .env

API="http://127.0.0.1:${API_HOST_PORT:-8080}"
GARAGE_ADMIN="http://127.0.0.1:${GARAGE_ADMIN_HOST_PORT:-3903}"
EXPECTED_VERSION="${APP_VERSION:-dev}"
METRICS_TOKEN="${METRICS_TOKEN:?METRICS_TOKEN ausente (rode scripts/dev-secrets.sh)}"
HEADERS_FILE="$(mktemp)"
trap 'rm -f "$HEADERS_FILE"' EXIT
failures=0

pass() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFALHA\033[0m %s\n' "$1"; failures=$((failures + 1)); }
check() { # $1 = descrição, demais = comando
  local description="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$description"; else fail "$description"; fi
}
expect_eq() { # $1 = descrição, $2 = esperado, $3 = obtido
  if [[ "$3" == "$2" ]]; then pass "$1"; else fail "$1 (esperado '$2', obtido '$3')"; fi
}

# Status HTTP exato de uma URL vista de DENTRO do container (Node 22 está em todas as imagens
# dos apps). Container fora do ar ou conexão recusada → "000", nunca um falso 401.
status_in() { # $1 = serviço, $2 = URL, $3 = Authorization (opcional)
  docker compose exec -T "$1" node -e '
    const [url, auth] = process.argv.slice(1);
    fetch(url, { headers: auth ? { authorization: auth } : {}, signal: AbortSignal.timeout(5000) })
      .then((res) => console.log(res.status), () => console.log("000"));
  ' "$2" "${3:-}" 2>/dev/null || echo "000"
}

echo "Smoke do compose (${API}, versão esperada ${EXPECTED_VERSION})"

running="$(docker compose ps --status running --services 2>/dev/null || true)"
for svc in video-api video-worker notification-service; do
  if grep -qx "$svc" <<<"$running"; then pass "$svc em execução"; else fail "$svc não está em execução"; fi
done

live="$(curl -fsS -H 'x-correlation-id: smoke-e0' -D "$HEADERS_FILE" "$API/api/health/live" || true)"
if [[ "$live" == *'"status":"ok"'* && "$live" == *'"service":"video-api"'* && "$live" == *"\"version\":\"${EXPECTED_VERSION}\""* ]]; then
  pass "video-api GET /api/health/live → $live"
else
  fail "video-api GET /api/health/live → '${live}' (versão esperada: ${EXPECTED_VERSION})"
fi
check "video-api devolve o x-correlation-id recebido" grep -qi '^x-correlation-id: smoke-e0' "$HEADERS_FILE"
expect_eq "video-api GET /api/health/ready → 200" 200 \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/health/ready" || true)"
expect_eq "video-api GET /api/docs-json (Swagger) → 200" 200 \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/docs-json" || true)"

for svc in video-api video-worker notification-service; do
  health="$(docker compose exec -T "$svc" wget -qO- http://127.0.0.1:9464/health 2>/dev/null || true)"
  if [[ "$health" == *'"status":"ok"'* && "$health" == *"\"service\":\"${svc}\""* && "$health" == *"\"version\":\"${EXPECTED_VERSION}\""* ]]; then
    pass "$svc :9464/health → $health"
  else
    fail "$svc :9464/health → '${health}'"
  fi
  expect_eq "$svc :9464/metrics sem token → 401" 401 \
    "$(status_in "$svc" http://127.0.0.1:9464/metrics)"
  expect_eq "$svc :9464/metrics com token errado → 401" 401 \
    "$(status_in "$svc" http://127.0.0.1:9464/metrics "Bearer token-errado-000000000000")"
  expect_eq "$svc :9464/metrics com token → 200" 200 \
    "$(status_in "$svc" http://127.0.0.1:9464/metrics "Bearer ${METRICS_TOKEN}")"
done

check "ffmpeg disponível no video-worker" docker compose exec -T video-worker ffmpeg -version
for svc in video-api notification-service; do
  expect_eq "ffmpeg ausente no $svc" ausente \
    "$(docker compose exec -T "$svc" sh -c 'command -v ffmpeg >/dev/null && echo presente || echo ausente' 2>/dev/null || true)"
done

init_state="$(docker compose ps -a --format '{{.State}} {{.ExitCode}}' garage-init 2>/dev/null || true)"
expect_eq "garage-init terminou com sucesso" "exited 0" "$init_state"

buckets="$(curl -fsS -H "Authorization: Bearer ${GARAGE_ADMIN_TOKEN:-}" "$GARAGE_ADMIN/v2/ListBuckets" || true)"
for bucket in fiapx-raw fiapx-zips; do
  if [[ "$buckets" == *"\"$bucket\""* ]]; then pass "bucket $bucket existe no Garage"; else fail "bucket $bucket ausente (${buckets})"; fi
done

key="$(curl -fsS -H "Authorization: Bearer ${GARAGE_ADMIN_TOKEN:-}" "$GARAGE_ADMIN/v2/GetKeyInfo?id=${S3_ACCESS_KEY_ID:-}" || true)"
if [[ "$key" == *'"fiapx-raw"'* && "$key" == *'"fiapx-zips"'* ]]; then
  pass "chave ${S3_ACCESS_KEY_ID:-} com acesso aos dois buckets"
else
  fail "chave ${S3_ACCESS_KEY_ID:-} sem acesso aos buckets (${key})"
fi

if [[ $failures -gt 0 ]]; then
  echo "Smoke: ${failures} falha(s)"
  exit 1
fi
echo "Smoke: tudo OK"
