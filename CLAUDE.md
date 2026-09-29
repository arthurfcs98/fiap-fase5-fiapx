# FIAP Frames: instruções do projeto

Hackathon FIAP SOAT, Fase 5 (formação da equipe **pendente de confirmação**; hoje só o Arthur
trabalha no repositório). Processamento de vídeos em
microsserviços: upload → fila → extração de frames (ffmpeg, 1 fps) → `.zip` → download,
com e-mail em caso de falha. Monorepo NestJS, deploy em K3s numa VM compartilhada.

## Stack

- **Runtime:** Node 22 (CI e imagens; `.nvmrc`); `engines` = `^22.13.0 || >=24.0.0`. Precisa
  funcionar também no Node 25 local (único aviso esperado: `EBADENGINE` do `@prometheus-io/client`).
- **Framework:** NestJS 11 (Express 5), TypeScript 5.9 `strict`, webpack (Nest CLI, modo monorepo).
- **Validação/config:** zod 4 (`loadConfig` com fail fast e segredos por `<CHAVE>_FILE`).
- **Logs:** nestjs-pino (JSON, `correlationId` em todo log, stdout síncrono).
- **Métricas:** `@prometheus-io/client` (sucessor oficial do `prom-client`), servidor interno na 9464.
  `MetricsServerModule.forRoot*` é **global**: importar só no módulo raiz; os demais injetam `METRICS_REGISTRY`.
- **Health:** `@nestjs/terminus` (`/api/health/live` e `/api/health/ready`).
- **Mensageria:** `amqplib` + `amqp-connection-manager` via `@fiapx/messaging` (`MessagingModule`
  global, `MessageConsumers.start(def)`, porta `EVENT_PUBLISHER`). Nunca usar amqplib direto nos apps.
- **Storage:** `@aws-sdk/client-s3` + `lib-storage` via `@fiapx/storage` (`StorageModule`, porta
  `OBJECT_STORAGE`). **Banco:** TypeORM 1.x + `pg` com `createTypeOrmOptions` de `@fiapx/common`.
- **Dependências:** todas as das etapas E3-E5 já estão no `package.json` (lista em
  `docs/arquitetura/libs.md`). Não adicionar pacote sem alinhar com o lead.
- **Infra local:** Postgres 16, RabbitMQ 4.3, Redis 7, Garage v2 (S3), Mailpit, via `compose.yaml`.
- **Testes:** Jest 30 + ts-jest (um project por app/lib), supertest no E2E, Testcontainers na
  integração (`*.int-spec.ts`, `npm run test:int`; o worker precisa de ffmpeg no PATH),
  jest-cucumber no BDD (`tests/bdd`, features em pt-BR, contra o compose), k6 em `tests/load`.
- **Hooks:** `simple-git-hooks` (instalado no `npm ci`) roda `scripts/git-hooks/pre-commit.sh`:
  `gitleaks protect --staged` (`.gitleaks.toml`) + `lint-staged`.
- **Lint:** ESLint 10 (flat config) + typescript-eslint (type-checked) + Prettier.

## Estrutura

```
apps/{video-api,video-worker,notification-service}/src
libs/{common,observability,messaging,contracts,storage}/src   # aliases @fiapx/<lib>
test/support/                    # @fiapx/testing (containers + waitFor), só para *.int-spec.ts
tests/bdd/ tests/load/ tests/fixtures/   # BDD (jest-cucumber), k6, gerador de vídeos de teste
examples/                        # vídeos pequenos versionados (usados pelo BDD, k6 e demos)
scripts/demo/ scripts/git-hooks/ # roteiros de demonstração e o pre-commit
docker/node-service.Dockerfile   compose.yaml   infra/{garage,postgres}   scripts/
docs/arquitetura/contratos.md    # FONTE DA VERDADE de nomes (filas, eventos, erros, tabelas, env)
docs/arquitetura/libs.md         # API pública das libs + exemplos (consumer, publish, storage, TypeORM)
legacy/projeto-base/             # código Go original (não alterar)
```

Pastas `infra/vm/`, `infra/k8s/` e `docs/estudos/` são do trabalho de deploy/K8s (E1).

## Comandos

```bash
npm ci
npm run lint          # zero warnings + prettier --check
npm run typecheck
npm run build         # ou build:<app>
npm test              # todos os projects
npm run test:cov      # cobertura por project (>= 80% em cada); -- apps/video-api para um só
npm run test:e2e
npm run test:int      # integração com RabbitMQ/Postgres/Garage reais (Testcontainers, precisa de Docker e ffmpeg)
npm run test:bdd      # BDD contra o stack no ar (make test-bdd sobe o stack certo e roda)
make up [WORKERS=3] | down | down-v | logs | ps | smoke | images | test-int
make test-bdd | load [VUS=20 DURATION=30s] | demo-happy | demo-sad | fixtures
```

## Convenções

- **Clean Architecture por módulo:** `modules/<nome>/{domain,application,infrastructure,interfaces}`.
  `domain` não importa Nest, TypeORM nem SDKs. Portas (interfaces) no domínio/aplicação,
  adaptadores em `infrastructure`, controllers/consumers em `interfaces`.
- **Nomes vêm de `docs/arquitetura/contratos.md`:** filas, routing keys, envelope, eventos,
  códigos de erro, tabelas e variáveis. Mudou lá, muda no código no mesmo PR (e vice-versa).
- **Erros:** `AppError`/`AppErrorException` de `@fiapx/common`, com prefixos
  **A** (Auth), **V** (Video), **P** (Processamento, gravado em `videos.error_code`) e
  **X** (Comum). Ex.: `throw VideoErrors.NOT_FOUND(id)` → `404 { error: { message: "VIDEO_NOT_FOUND", code: "V0001", ... } }`.
  Falhas de fila: `RetryableError` (transitória), `DependencyUnavailableError` (dependência fora:
  Postgres, storage, SMTP) e `NonRetryableError` (permanente). Na API, erro de conexão com uma
  dependência vira `503 X0003` com `Retry-After` (nunca 500, e nunca 401 na validação do JWT).
- **Config:** um schema zod por app (`config/*.config.ts`) exposto por token via
  `TypedConfigModule`. Nunca ler `process.env` fora do loader.
- **Correlation id:** HTTP usa o header `x-correlation-id` (até 100 caracteres, o tamanho da
  coluna do outbox). O `correlationIdMiddleware` (registrado no `configureApp`) abre o contexto
  para a requisição inteira, inclusive o filtro de exceções. Consumidores de fila devem
  envolver o handler em `runWithCorrelation(id, fn)`.
- **Código só de teste fora dos barrels:** fixtures em `@fiapx/contracts/fixtures`, fakes em
  `@fiapx/storage/testing` e `@fiapx/messaging/testing` (subpaths), para não entrarem no bundle de
  produção. Containers de integração em `@fiapx/testing` (`test/support`, fora de `src`).
- **Mensageria:** consumidor = provider na camada `interfaces` que chama
  `MessageConsumers.start({ queue: QUEUES.x, schema, handle, onPermanentFailure? })` no
  `onApplicationBootstrap`. Falha transitória → lançar `RetryableError` (erro desconhecido também
  vira retry); dependência fora → `DependencyUnavailableError` (ou deixar o erro de conexão
  subir): o consumo pausa sem gastar retry; permanente → `NonRetryableError` (catálogo
  `ProcessingErrors`). Repassar `ctx.signal` para operações longas (ffmpeg, S3): ele aborta quando
  o canal da mensagem fecha, e depois disso nada é confirmado nem publicado. Publicar só por
  `EVENT_PUBLISHER` com `createEvent(type, payload, correlationId)`.
- **Fila ou binding novo:** além de `libs/messaging/src/topology.ts` e do contrato, atualizar as
  regex de permissão dos usuários por serviço em `infra/k8s/base/data/rabbitmq/rabbitmq-init.mjs`
  (o `libs/messaging/test/rabbitmq-permissions.int-spec.ts` falha se esquecer). No K8s a
  topologia é criada pelo Job `rabbitmq-init` (entry `setup-topology.js` do video-api, como
  admin); os serviços só a redeclaram.
- **Integração:** `apps/<app>/test/*.int-spec.ts` ou `libs/<lib>/test/*.int-spec.ts` entram
  sozinhos no `jest.int.config.js`; imagens dos containers vêm do `compose.yaml`.
- **Pacotes só ESM** (ex.: `file-type`): o Jest os converte para CommonJS pela lista
  `ESM_ONLY_PACKAGES` do `jest.preset.js` (incluir as dependências ESM do pacote também).
- **TypeScript:** `tsconfig.json` (IDE, lint, typecheck) inclui os tipos do Jest; o código de
  produção compila sem eles (`tsconfig.app.json`/`tsconfig.lib.json` e o 2º passo do `typecheck`,
  `tsconfig.build.json`). O Jest **não checa tipos** (`diagnostics: false` no `jest.preset.js`):
  o ts-jest força CommonJS + resolução node10, diferente do `nodenext` do build. A única
  checagem de tipos (specs inclusive) é o `npm run typecheck`, no mesmo modo do build.
- **Imports:** `import type` para tipos (obrigatório com `isolatedModules` + decorators).
- **Testes:** todo código novo com teste unitário. Cobertura ≥ 80% por project, sem novas
  exclusões (só `main.ts`, `*.module.ts` e `index.ts`). Comportamento visível de ponta a ponta
  ganha cenário BDD em `tests/bdd/features` (pt-BR); o arquivo `99-*` confere que nenhum dado
  pessoal aparece nos logs e precisa continuar sendo o último.
- **Throttling:** `@ThrottleBy('register'|'login'|'upload'|'accountDeletion')` na rota; limites
  em `THROTTLE_*_LIMIT` (padrões do contrato; o compose local folga cadastro, login por IP e
  upload). O login tem dois limites: por IP + e-mail e por IP (`THROTTLE_LOGIN_IP_LIMIT`); IPv6
  conta por prefixo `/64`. Capacidade do upload: `MAX_CONCURRENT_UPLOADS` por réplica (503) e
  `MAX_PENDING_VIDEOS_PER_USER` (429 `V0007`).
- **Logs de acesso:** o pino só registra método, caminho sem query e status (a query do download
  tem a assinatura; os headers têm o nome do arquivo). Nunca logar e-mail, nome ou `originalName`.
- **Docs no mesmo PR:** mudou comportamento, contrato, env ou comando → atualizar README,
  `contratos.md` e este arquivo no mesmo PR.
- **Nunca commitar segredos.** Local: `.env` gerado por `scripts/dev-secrets.sh`. Produção:
  segredos só na VM/cluster. Nada de defaults de senha no código.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `ci:`,
  `refactor:`), em português ou inglês, mensagens curtas e no imperativo.
- **Branches:** trunk-based, PR para `main`; o check exigido é o `ci-ok`.

## Cuidados

- A VM compartilhada hospeda outros projetos em produção (fora do escopo). Nenhuma mudança
  nela sem autorização explícita do Arthur, e nenhum IP, hostname ou nome desses projetos
  entra no repositório (ele é público).
- `legacy/` é histórico: não refatorar.
- **`package-lock.json` só com o npm do Node 22 (npm 10)**, o mesmo da imagem e do CI. O npm 11
  (Node 24/25) reescreve o lock sem as entradas opcionais `@emnapi/*` e o `npm ci` do Node 22
  passa a falhar (`Missing: @emnapi/core from lock file`). Para mudar dependências com Node 25
  local: `docker run --rm -v "$PWD:/app" -w /app <imagem node:22 do Dockerfile> npm install
  --package-lock-only --ignore-scripts`.
- Imagens (base do Dockerfile e infra do compose) são fixadas por tag + digest; ao atualizar,
  trocar os dois (o Dependabot já faz assim).
- Actions do CI fixadas pelo SHA do commit, com a versão em comentário.
- A imagem publicada no GHCR é a mesma que passou no smoke do compose (artefato do job
  `build-images`); não reintroduzir rebuild no job de publicação.
