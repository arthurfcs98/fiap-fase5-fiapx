#!/bin/sh
# Cria um banco e um usuário por serviço (executado pelo entrypoint oficial do Postgres
# apenas na PRIMEIRA inicialização do volume). Senhas vêm do ambiente (.env local).
set -eu

: "${VIDEO_DB_PASSWORD:?VIDEO_DB_PASSWORD não definida (rode scripts/dev-secrets.sh)}"
: "${NOTIF_DB_PASSWORD:?NOTIF_DB_PASSWORD não definida (rode scripts/dev-secrets.sh)}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set video_pw="$VIDEO_DB_PASSWORD" \
  --set notif_pw="$NOTIF_DB_PASSWORD" <<'SQL'
CREATE ROLE fiapx_video LOGIN PASSWORD :'video_pw';
CREATE DATABASE fiapx_video OWNER fiapx_video;
REVOKE ALL ON DATABASE fiapx_video FROM PUBLIC;

CREATE ROLE fiapx_notification LOGIN PASSWORD :'notif_pw';
CREATE DATABASE fiapx_notification OWNER fiapx_notification;
REVOKE ALL ON DATABASE fiapx_notification FROM PUBLIC;
SQL

echo "[postgres-init] bancos fiapx_video e fiapx_notification criados"
