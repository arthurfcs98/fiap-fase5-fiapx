#!/usr/bin/env bash
# =============================================================================
# Demo (caminho triste): upload de um vídeo corrompido → FAILED (P0001) → e-mail de falha no
# Mailpit, com o mesmo correlation id do upload.
#
#   make up && make demo-sad
#   scripts/demo/sad-path.sh [arquivo]                (padrão: examples/sample-corrupt.mp4)
#
# Variáveis opcionais: API, MAILPIT (http://127.0.0.1:8025), DEMO_EMAIL, DEMO_PASSWORD, DEMO_NAME.
# =============================================================================
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

VIDEO_FILE="${1:-$DEMO_ROOT/examples/sample-corrupt.mp4}"

demo_require
demo_login
demo_upload "$VIDEO_FILE"
demo_wait

[[ "$(jq -r .status <<<"$VIDEO_JSON")" == FAILED ]] \
  || fail "esperado FAILED, veio $(jq -r .status <<<"$VIDEO_JSON")"
info "FAILED: $(jq -r '"\(.errorCode) — \(.errorMessage)"' <<<"$VIDEO_JSON")"

bold "5. Download recusado (não há zip)"
code="$(curl -sS -o /tmp/fiapx-demo-dl.json -w '%{http_code}' -X POST "$API/api/videos/$VIDEO_ID/download-url" \
  -H "authorization: Bearer $TOKEN")"
info "POST /api/videos/$VIDEO_ID/download-url → $code $(jq -c '.error | {code, message}' /tmp/fiapx-demo-dl.json)"
rm -f /tmp/fiapx-demo-dl.json

bold "6. E-mail de falha no Mailpit ($MAILPIT)"
query="$(jq -rn --arg e "$EMAIL" '"to:\"" + $e + "\"" | @uri')"
message=""
for _ in $(seq 1 30); do
  message="$(curl -fsS "$MAILPIT/api/v1/search?query=$query" | jq -c '.messages[0] // empty')"
  [[ -n "$message" ]] && break
  sleep 1
done
[[ -n "$message" ]] || fail "nenhum e-mail para $EMAIL em 30 s (confira: docker compose logs notification-service)"
id="$(jq -r .ID <<<"$message")"
info "assunto: $(jq -r .Subject <<<"$message")"
info "X-Correlation-Id: $(curl -fsS "$MAILPIT/api/v1/message/$id/headers" | jq -r '."X-Correlation-Id"[0]') (upload: $CORRELATION_ID)"
info "abrir no navegador: $MAILPIT/view/$id"

bold "Pronto. Para investigar pelo correlation id:"
info "docker compose logs video-api video-worker notification-service | grep $CORRELATION_ID"
