# FIAP X: processamento de vídeos em microsserviços

Hackathon da pós-graduação **Software Architecture (FIAP, turma 14SOAT), Fase 5**.

O FIAP X recebe vídeos, extrai um frame por segundo e entrega um `.zip` com as imagens.
O projeto base (um único programa em Go, síncrono e sem persistência) foi reescrito como
três microsserviços NestJS que se comunicam por fila:

| Serviço | Papel | Interface |
|---|---|---|
| `video-api` | Cadastro/login (JWT), upload, status, download, outbox | HTTP `:3000` (prefixo `/api`) + `:9464` interno |
| `video-worker` | ffprobe/ffmpeg (`fps=1`) e zip em streaming para o storage | só `:9464` interno (`/health`, `/metrics`) |
| `notification-service` | E-mail de falha (Resend em produção, Mailpit local) | só `:9464` interno (`/health`, `/metrics`) |

Infra: PostgreSQL 16, RabbitMQ 4.3, Redis 7, Garage (S3), Mailpit; Prometheus/Grafana e
Kubernetes (K3s) nas próximas etapas.

> **Status: E0 (esqueleto).** Monorepo, libs compartilhadas, health checks, logs, métricas,
> testes, Dockerfile, compose e CI de PR. As regras de negócio entram a partir da E2/E3.

## Como rodar

Pré-requisitos: Node 22.13+ (`.nvmrc`; CI e imagens usam o 22), Docker com Compose v2 e `make`.
O `engines` aceita `^22.13.0 || >=24.0.0`. Exceção conhecida: no Node 25 o `npm ci` avisa
`EBADENGINE` porque o `@prometheus-io/client` só declara Node 22, 24 e 26+; o aviso é esperado
e lint, testes e build passam.

```bash
npm ci
make up        # gera o .env (segredos locais aleatórios) e sobe infra + apps com build
make smoke     # confere health, métricas, buckets do Garage
make down      # derruba (make down-v apaga também os volumes)
```

Depois do `make up`:

| O quê | Onde |
|---|---|
| API (Swagger) | http://localhost:8080/api/docs (porta publicada só em `127.0.0.1`) |
| Liveness | http://localhost:8080/api/health/live |
| Mailpit | http://localhost:8025 |
| RabbitMQ (usuário `fiapx`, senha no `.env`) | http://localhost:15672 |
| Garage S3 / Admin API | http://localhost:3900 / http://localhost:3903 |

Os segredos locais ficam **só** no `.env` (gitignored), gerado por `scripts/dev-secrets.sh`
a partir do `.env.example`. Rodar de novo nunca sobrescreve valores existentes. Variáveis
exportadas no shell ganham do `.env`, tanto no compose quanto no `make smoke`
(ex.: `FIAPX_IMAGE_TAG=sha-abc1234 APP_VERSION=sha-abc1234 make smoke`).

### Desenvolvimento sem Docker (apps)

Os três apps sobem um servidor interno de `/health` e `/metrics` em `METRICS_PORT` (padrão
9464, inclusive o `video-api`). Rodando juntos na mesma máquina, cada um precisa da sua porta:

```bash
npm run start:dev:video-api                                  # http://localhost:3000/api/docs · métricas :9464
METRICS_PORT=9465 npm run start:dev:video-worker             # http://localhost:9465/health
METRICS_PORT=9466 npm run start:dev:notification-service     # http://localhost:9466/health
```

## Comandos

| Comando | O que faz |
|---|---|
| `npm run lint` | ESLint (flat config, zero warnings) + Prettier `--check` |
| `npm run typecheck` | `tsc --noEmit` em todo o monorepo e, de novo, só no código de produção sem os tipos do Jest (`tsconfig.build.json`) |
| `npm run build` / `build:<app>` | Build webpack (`dist/apps/<app>/main.js`) |
| `npm test` | Testes unitários de todos os projects (não checam tipos; isso é papel do `typecheck`) |
| `npm run test:cov [-- <project>] [--flag=valor]` | Cobertura **por project**, threshold de 80% em cada um (flags vão para o Jest) |
| `npm run test:e2e` | E2E do `video-api` com supertest |
| `make up` / `down` / `down-v` / `logs` / `ps` / `smoke` / `images` | Atalhos do compose |

## Estrutura

```
apps/
  video-api/              # HTTP público (/api), Swagger, Terminus
  video-worker/           # contexto Nest standalone (sem HTTP público)
  notification-service/   # contexto Nest standalone (sem HTTP público)
libs/
  common/                 # AppError + catálogo A/V/P/X, filtro global, config com zod
  observability/          # pino, correlation id (AsyncLocalStorage), métricas e /health internos
  messaging/              # topologia RabbitMQ, decisão de retry, headers
  contracts/              # envelope e eventos (zod); fixtures v1 em @fiapx/contracts/fixtures (só testes)
  storage/                # porta de object storage, chaves, config S3; fake em @fiapx/storage/testing
docker/node-service.Dockerfile   # um Dockerfile parametrizado (ARG APP, WITH_FFMPEG, APP_VERSION, VCS_REF)
docker/healthcheck.sh            # HEALTHCHECK das imagens (URL derivada do app)
compose.yaml                     # stack local e do CI
infra/garage/                    # garage.toml (nó único) e init idempotente (layout, chave, buckets)
infra/postgres/init/             # um banco e um usuário por serviço
scripts/                         # dev-secrets.sh, compose-smoke.sh, test-cov.mjs
legacy/projeto-base/             # o "antes": código Go original
.github/workflows/ci.yml         # CI de PR e da main (build, smoke e publicação das imagens)
.github/dependabot.yml           # atualização de actions, imagens base e npm
```

Cada módulo de app segue Clean Architecture (`domain/`, `application/`, `infrastructure/`,
`interfaces/`). Detalhes e convenções em [`CLAUDE.md`](CLAUDE.md).

## CI/CD

`.github/workflows/ci.yml` roda em todo PR e em push na `main`:

1. **quality**: `npm ci`, lint, typecheck, build, actionlint, hadolint (`.hadolint.yaml`) e shellcheck;
2. **test**: matrix com um job por app/lib, cobertura ≥ 80% em cada um (artefato `coverage-<project>`);
3. **e2e**: E2E do `video-api`;
4. **build-images**: build das 3 imagens **uma única vez** (cache do GitHub Actions), com
   `APP_VERSION=sha-<7>`, exportadas como artefato;
5. **compose smoke**: carrega essas imagens (sem rebuild), sobe o stack inteiro com
   `docker compose up --no-build --wait` e roda `scripts/compose-smoke.sh` conferindo a versão `sha-<7>`;
6. **images** (só no push na `main`, e só se 1 a 5 passaram): publica **as mesmas imagens do smoke**
   em `ghcr.io/arthurfcs98/fiapx-<app>:sha-<7>` e `:main` com o `GITHUB_TOKEN` (único job com
   `packages: write`). A saída `tag` do job e o resumo da execução trazem a tag e os digests;
7. **ci-ok**: agregador. É o único check exigido na branch protection.

Actions fixadas pelo SHA do commit; o Dependabot (`.github/dependabot.yml`) propõe as
atualizações de actions, imagens base (Dockerfile e compose) e dependências npm.

Pontos para o deploy (E1):

- **Sempre fixar `sha-<7>`**, nunca `:main`: com pushes seguidos, o GitHub cancela a execução
  pendente do meio e aquele commit fica sem imagem publicada.
- **Visibilidade no GHCR**: pacotes publicados pela primeira vez numa conta pessoal nascem
  **privados**. Antes do primeiro deploy, deixe os 3 pacotes `fiapx-*` públicos (Package settings →
  Change visibility) ou crie no cluster um `imagePullSecret` com um PAT `read:packages`.
- **Rate limit do Docker Hub (opcional)**: com a variável `DOCKERHUB_USERNAME` e o segredo
  `DOCKERHUB_TOKEN` (token somente leitura) definidos no repositório, os jobs fazem login antes
  de baixar imagens; sem eles, os pulls seguem anônimos.

## Documentação

- Contratos entre serviços (filas, eventos, erros, banco): [`docs/arquitetura/contratos.md`](docs/arquitetura/contratos.md).
- Planejamento (plano de execução e proposta de arquitetura): serão publicados em
  `docs/planejamento/`.
- Garage local: [`infra/garage/README.md`](infra/garage/README.md).
- Projeto original em Go: [`legacy/projeto-base/`](legacy/projeto-base/).
