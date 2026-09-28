#!/usr/bin/env bash
# =============================================================================
# Gera o .env local a partir do .env.example (idempotente).
#
# - Chaves que já existem no .env são mantidas (nunca sobrescreve).
# - Chaves novas com valor no .env.example são copiadas como estão.
# - Chaves novas SEM valor são segredos: recebem um valor aleatório no formato certo.
#
# Uso: scripts/dev-secrets.sh [arquivo-de-saída]   (padrão: .env na raiz do repo)
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE="$ROOT/.env.example"
TARGET="${1:-$ROOT/.env}"

[[ -f "$EXAMPLE" ]] || { echo "dev-secrets: $EXAMPLE não encontrado" >&2; exit 1; }

random_hex() { # $1 = bytes
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

generate() { # $1 = nome da chave
  case "$1" in
    GARAGE_RPC_SECRET)    random_hex 32 ;;          # Garage exige 32 bytes em hex
    S3_ACCESS_KEY_ID)     echo "GK$(random_hex 12)" ;; # formato de chave do Garage
    S3_SECRET_ACCESS_KEY) random_hex 32 ;;
    *)                    random_hex 24 ;;          # senhas/tokens: 48 hex, seguros em URL
  esac
}

touch "$TARGET"
chmod 600 "$TARGET"
# Arquivo editado à mão sem quebra de linha no fim: sem isto, a 1ª chave anexada grudaria
# na última linha (FOO=1COMPOSE_PROJECT_NAME=fiapx).
if [[ -s "$TARGET" && -n "$(tail -c1 "$TARGET")" ]]; then
  echo >> "$TARGET"
fi

has_key() { grep -qE "^$1=" "$TARGET"; }

added=0
generated=0
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^[[:space:]]*# || -z "${line// /}" ]] && continue
  [[ "$line" =~ ^([A-Z0-9_]+)=(.*)$ ]] || continue
  key="${BASH_REMATCH[1]}"
  value="${BASH_REMATCH[2]}"
  has_key "$key" && continue
  if [[ -z "$value" ]]; then
    value="$(generate "$key")"
    generated=$((generated + 1))
  fi
  printf '%s=%s\n' "$key" "$value" >> "$TARGET"
  added=$((added + 1))
done < "$EXAMPLE"

relative="${TARGET#"$ROOT"/}"
if [[ $added -eq 0 ]]; then
  echo "dev-secrets: $relative já está completo (nada alterado)"
else
  echo "dev-secrets: $relative atualizado: $added chave(s), $generated segredo(s) gerado(s)"
fi
