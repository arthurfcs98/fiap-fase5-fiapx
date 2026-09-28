#!/bin/sh
# Healthcheck das imagens do FIAP X (HEALTHCHECK do Dockerfile). BusyBox wget, sem curl.
# A URL deriva do app, então nenhuma imagem nasce "sempre unhealthy" por falta de build-arg:
#   video-api                        → http://127.0.0.1:${PORT:-3000}/api/health/live
#   video-worker, notification-service → http://127.0.0.1:${METRICS_PORT:-9464}/health
# HEALTH_URL no ambiente do container sobrescreve a URL derivada.
set -eu

if [ -z "${HEALTH_URL:-}" ]; then
  case "${APP_NAME:-}" in
    video-api) HEALTH_URL="http://127.0.0.1:${PORT:-3000}/api/health/live" ;;
    *) HEALTH_URL="http://127.0.0.1:${METRICS_PORT:-9464}/health" ;;
  esac
fi

exec wget -q -T 2 -O /dev/null "$HEALTH_URL"
