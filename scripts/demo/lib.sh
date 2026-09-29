#!/usr/bin/env bash
# Funções comuns dos roteiros de demonstração (scripts/demo/*.sh). Use com `source`.
# Nada fixo: usuário, e-mail e ids vêm das respostas da API em tempo de execução.

DEMO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Portas publicadas: as exportadas no shell ganham do .env (mesma regra do Compose).
demo_load_env() {
  local line key value
  [[ -f "$DEMO_ROOT/.env" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    [[ -n "${!key+x}" ]] && continue
    export "$key=$value"
  done < "$DEMO_ROOT/.env"
}
demo_load_env

API="${API:-http://127.0.0.1:${API_HOST_PORT:-8080}}"
MAILPIT="${MAILPIT:-http://127.0.0.1:${MAILPIT_UI_HOST_PORT:-8025}}"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\033[31mERRO:\033[0m %s\n' "$*" >&2; exit 1; }

demo_require() {
  local tool
  for tool in curl jq; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool não encontrado (brew install $tool | apt-get install $tool)"
  done
  curl -fsS "$API/api/health/ready" >/dev/null 2>&1 || fail "API fora do ar em $API (rode: make up)"
}

# Cadastra um usuário novo (ou usa DEMO_EMAIL/DEMO_PASSWORD) e exporta TOKEN, USER_ID, EMAIL.
demo_login() {
  EMAIL="${DEMO_EMAIL:-demo.$(date +%s).$RANDOM@example.com}"
  local password="${DEMO_PASSWORD:-senha-demo-123}"
  local name="${DEMO_NAME:-Pessoa Demo}"
  bold "1. Cadastro ($EMAIL) — com aceite da política de privacidade"
  local body status
  body="$(jq -n --arg n "$name" --arg e "$EMAIL" --arg p "$password" \
    '{name: $n, email: $e, password: $p, acceptPrivacyPolicy: true}')"
  status="$(curl -sS -o /tmp/fiapx-demo-register.json -w '%{http_code}' -X POST "$API/api/auth/register" \
    -H 'content-type: application/json' -d "$body")"
  case "$status" in
    201) info "POST /api/auth/register → 201 $(jq -c . /tmp/fiapx-demo-register.json)" ;;
    409) info "POST /api/auth/register → 409 (e-mail já cadastrado): segue para o login" ;;
    *) fail "cadastro respondeu $status: $(cat /tmp/fiapx-demo-register.json)" ;;
  esac
  rm -f /tmp/fiapx-demo-register.json

  bold "2. Login"
  local login
  login="$(curl -fsS -X POST "$API/api/auth/login" -H 'content-type: application/json' \
    -d "$(jq -n --arg e "$EMAIL" --arg p "$password" '{email: $e, password: $p}')")" \
    || fail "login falhou"
  TOKEN="$(jq -r .accessToken <<<"$login")"
  USER_ID="$(curl -fsS "$API/api/auth/me" -H "authorization: Bearer $TOKEN" | jq -r .id)"
  info "POST /api/auth/login → 200 (token JWT de $(jq -r .expiresIn <<<"$login") s)"
  info "GET  /api/auth/me    → id $USER_ID"
  export TOKEN USER_ID EMAIL
}

# demo_upload <arquivo> → exporta VIDEO_ID e CORRELATION_ID
demo_upload() {
  local file="$1"
  [[ -f "$file" ]] || fail "arquivo $file não existe (rode: make fixtures ou tests/fixtures/generate.sh --examples)"
  CORRELATION_ID="demo-$(date +%s)-$RANDOM"
  bold "3. Upload de $(basename "$file") ($(wc -c <"$file" | tr -d ' ') bytes) — correlation id $CORRELATION_ID"
  local res
  res="$(curl -fsS -X POST "$API/api/videos" -H "authorization: Bearer $TOKEN" \
    -H "x-correlation-id: $CORRELATION_ID" -H "idempotency-key: $CORRELATION_ID" \
    -F "video=@$file")" || fail "upload recusado"
  VIDEO_ID="$(jq -r .id <<<"$res")"
  info "POST /api/videos → 202 $(jq -c . <<<"$res")"
  export VIDEO_ID CORRELATION_ID
}

# demo_wait → espera o estado terminal e exporta VIDEO_JSON
demo_wait() {
  bold "4. Acompanhando o status (GET /api/videos/$VIDEO_ID a cada 1 s)"
  local last="" status i
  for i in $(seq 1 180); do
    VIDEO_JSON="$(curl -fsS "$API/api/videos/$VIDEO_ID" -H "authorization: Bearer $TOKEN")"
    status="$(jq -r .status <<<"$VIDEO_JSON")"
    if [[ "$status" != "$last" ]]; then info "t=${i}s status=$status"; last="$status"; fi
    [[ "$status" == COMPLETED || "$status" == FAILED ]] && break
    sleep 1
  done
  [[ "$status" == COMPLETED || "$status" == FAILED ]] || fail "o vídeo não terminou em 180 s"
  info "histórico: $(jq -c '[.history[] | "\(.fromStatus // "-") → \(.toStatus): \(.reason)"]' <<<"$VIDEO_JSON")"
  export VIDEO_JSON
}
