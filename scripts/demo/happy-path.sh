#!/usr/bin/env bash
# =============================================================================
# Demo (caminho feliz): cadastro → login → upload → processamento → download do .zip.
#
#   make up && make demo-happy
#   scripts/demo/happy-path.sh [arquivo-de-video]     (padrão: examples/sample-ok-10s.mp4)
#
# Variáveis opcionais: API (http://127.0.0.1:8080), DEMO_EMAIL, DEMO_PASSWORD, DEMO_NAME,
# OUT_DIR (onde salvar o zip; padrão: diretório temporário).
# =============================================================================
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

VIDEO_FILE="${1:-$DEMO_ROOT/examples/sample-ok-10s.mp4}"
OUT_DIR="${OUT_DIR:-$(mktemp -d)}"

demo_require
demo_login
demo_upload "$VIDEO_FILE"
demo_wait

[[ "$(jq -r .status <<<"$VIDEO_JSON")" == COMPLETED ]] \
  || fail "esperado COMPLETED, veio $(jq -c '{status, errorCode, errorMessage}' <<<"$VIDEO_JSON")"
info "COMPLETED: $(jq -r .frameCount <<<"$VIDEO_JSON") frames, zip de $(jq -r .zipSizeBytes <<<"$VIDEO_JSON") bytes"

bold "5. Link de download assinado (HMAC, válido por 5 min)"
link="$(curl -fsS -X POST "$API/api/videos/$VIDEO_ID/download-url" -H "authorization: Bearer $TOKEN")"
info "POST /api/videos/$VIDEO_ID/download-url → 200 (expira em $(jq -r .expiresAt <<<"$link"))"

bold "6. Download do .zip (o link não precisa de token)"
zip_file="$OUT_DIR/$VIDEO_ID.zip"
curl -fsS -o "$zip_file" "$(jq -r .url <<<"$link")"
info "salvo em $zip_file ($(wc -c <"$zip_file" | tr -d ' ') bytes)"
if command -v unzip >/dev/null 2>&1; then
  unzip -l "$zip_file" | sed 's/^/    /'
fi

bold "Pronto. Veja também:"
info "Frontend:        $API/"
info "E-mail de sucesso no Mailpit: $MAILPIT (NOTIFY_ON_SUCCESS=true no compose)"
info "Logs do caminho: docker compose logs video-api video-worker notification-service | grep $CORRELATION_ID"
