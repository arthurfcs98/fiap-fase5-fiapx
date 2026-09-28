# FIAP X: instruções do projeto

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
- **Infra local:** Postgres 16, RabbitMQ 4.3, Redis 7, Garage v2 (S3), Mailpit, via `compose.yaml`.
- **Testes:** Jest 30 + ts-jest (um project por app/lib), supertest no E2E.
- **Lint:** ESLint 10 (flat config) + typescript-eslint (type-checked) + Prettier.

## Estrutura

```
apps/{video-api,video-worker,notification-service}/src
libs/{common,observability,messaging,contracts,storage}/src   # aliases @fiapx/<lib>
docker/node-service.Dockerfile   compose.yaml   infra/{garage,postgres}   scripts/
docs/arquitetura/contratos.md    # FONTE DA VERDADE de nomes (filas, eventos, erros, tabelas, env)
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
make up | down | down-v | logs | ps | smoke | images
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
  Falhas de fila: `RetryableError` (transitória) e `NonRetryableError` (permanente).
- **Config:** um schema zod por app (`config/*.config.ts`) exposto por token via
  `TypedConfigModule`. Nunca ler `process.env` fora do loader.
- **Correlation id:** HTTP usa o header `x-correlation-id` (até 100 caracteres, o tamanho da
  coluna do outbox). O `correlationIdMiddleware` (registrado no `configureApp`) abre o contexto
  para a requisição inteira, inclusive o filtro de exceções. Consumidores de fila devem
  envolver o handler em `runWithCorrelation(id, fn)`.
- **Código só de teste fora dos barrels:** fixtures em `@fiapx/contracts/fixtures`, fakes em
  `@fiapx/storage/testing` (subpaths), para não entrarem no bundle de produção.
- **TypeScript:** `tsconfig.json` (IDE, lint, typecheck) inclui os tipos do Jest; o código de
  produção compila sem eles (`tsconfig.app.json`/`tsconfig.lib.json` e o 2º passo do `typecheck`,
  `tsconfig.build.json`). O Jest **não checa tipos** (`diagnostics: false` no `jest.preset.js`):
  o ts-jest força CommonJS + resolução node10, diferente do `nodenext` do build. A única
  checagem de tipos (specs inclusive) é o `npm run typecheck`, no mesmo modo do build.
- **Imports:** `import type` para tipos (obrigatório com `isolatedModules` + decorators).
- **Testes:** todo código novo com teste unitário. Cobertura ≥ 80% por project, sem novas
  exclusões (só `main.ts`, `*.module.ts` e `index.ts`).
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
- Imagens (base do Dockerfile e infra do compose) são fixadas por tag + digest; ao atualizar,
  trocar os dois (o Dependabot já faz assim).
- Actions do CI fixadas pelo SHA do commit, com a versão em comentário.
- A imagem publicada no GHCR é a mesma que passou no smoke do compose (artefato do job
  `build-images`); não reintroduzir rebuild no job de publicação.
