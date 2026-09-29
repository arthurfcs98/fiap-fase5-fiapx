#!/usr/bin/env bash
# =============================================================================
# pre-commit (instalado pelo simple-git-hooks no `npm ci`/`npm install`; config no package.json):
#   1. gitleaks nas mudanças staged (regras em .gitleaks.toml): bloqueia segredo antes do commit;
#   2. lint-staged: ESLint (--fix) e Prettier (--write) só nos arquivos staged.
# Sem o binário do gitleaks, usa a MESMA imagem do job `security` do CI (precisa de Docker).
# Pular num caso excepcional (e o CI ainda roda o gitleaks no histórico): git commit --no-verify
# =============================================================================
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
GITLEAKS_IMAGE=ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f

echo "pre-commit: gitleaks (mudanças staged)"
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks protect --staged --redact --no-banner --config .gitleaks.toml
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  # safe.directory: dentro do container o repositório pertence a outro usuário.
  docker run --rm -v "$ROOT:/repo" -w /repo \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "$GITLEAKS_IMAGE" protect --staged --redact --no-banner --config .gitleaks.toml --source /repo
else
  echo "pre-commit: instale o gitleaks (brew install gitleaks) ou suba o Docker; commit bloqueado." >&2
  exit 1
fi

echo "pre-commit: lint-staged"
npx --no-install lint-staged
