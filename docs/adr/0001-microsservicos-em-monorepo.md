# ADR-0001: Três microsserviços num monorepo NestJS

- Status: aceita
- Data: 2026-09-28

## Contexto

O projeto base é um único programa em Go que recebe o vídeo, roda o ffmpeg e devolve o zip
dentro da mesma requisição. O enunciado pede processamento paralelo, nenhuma perda em picos,
autenticação, listagem de status e aviso por e-mail.

As partes do problema têm perfis muito diferentes:

- a **API** é I/O e latência: precisa responder rápido e sempre;
- o **processamento** é CPU e tempo: um vídeo pode levar minutos e ocupar um núcleo inteiro;
- o **e-mail** depende de um provedor externo que pode ficar lento ou fora do ar.

Nas fases anteriores do curso, cada serviço tinha o próprio repositório e o código de
mensageria foi copiado entre eles; as cópias divergiram e um bug de retry se espalhou.

## Decisão

- **Três serviços**, cada um com deploy, escala e dados próprios, conversando por eventos no
  RabbitMQ:
  - `video-api`: HTTP público, autenticação, upload, status, download, outbox e dona da máquina
    de estados do vídeo (banco `fiapx_video`);
  - `video-worker`: consome `worker.video-uploaded` e roda ffprobe/ffmpeg; sem banco, sem HTTP
    público;
  - `notification-service`: consome `notification.events` e envia e-mail (banco
    `fiapx_notification`).
- A autenticação é um **módulo isolado dentro do `video-api`** (`modules/auth`), extraível se um
  dia houver outro emissor ou consumidor de tokens.
- **Um monorepo NestJS** (`apps/` + `libs/`), com o código comum numa cópia só:
  `@fiapx/messaging`, `@fiapx/contracts`, `@fiapx/storage`, `@fiapx/observability` e
  `@fiapx/common`. Um Dockerfile parametrizado gera as 3 imagens; o CI testa cada app e cada lib
  como um project separado (cobertura mínima de 80% em cada).
- Cada módulo segue **Clean Architecture** (`domain`, `application`, `infrastructure`,
  `interfaces`).

## Consequências

**Positivas (+)**

- Escala independente: o worker escala pelo tamanho da fila e a API por CPU (ADR-0007).
- Isolamento de falhas: o provedor de e-mail fora não afeta o upload; o worker caindo não afeta
  a API; um pico só aumenta a fila.
- Regras críticas (retry, DLQ, envelope, correlation id) implementadas uma única vez nas libs e
  validadas dos dois lados (schemas zod em `libs/contracts`).
- Mudanças que cruzam serviços (ex.: um campo novo num evento) entram num único PR, testadas
  juntas no BDD.

**Negativas (−)**

- Sistema distribuído: consistência eventual, entrega at-least-once e necessidade de
  idempotência em todos os consumidores (ADR-0004).
- As 3 imagens saem juntas a cada commit da `main` (mesma tag `sha-<7>`); não há deploy
  independente por serviço.
- Uma mudança numa lib afeta todos os serviços; a cobertura por project e o BDD são a rede de
  segurança.

## Alternativas rejeitadas

| Alternativa | Por que não |
|---|---|
| Monólito modular (API e worker no mesmo processo) | o ffmpeg disputaria CPU com as requisições HTTP e não daria para escalar só o processamento |
| Quatro serviços, com um `auth-service` separado | mais um deploy, tokens assimétricos e JWKS, sem atender nenhum requisito a mais |
| Um repositório por serviço | código de mensageria duplicado e deriva entre cópias (o problema das fases anteriores) |

## Onde está

- `apps/video-api`, `apps/video-worker`, `apps/notification-service`
- `libs/{common,observability,messaging,contracts,storage}` e [`docs/arquitetura/libs.md`](../arquitetura/libs.md)
- `docker/node-service.Dockerfile` (`APP`, `WITH_FFMPEG`), `nest-cli.json`, `jest.config.js`
- `.github/workflows/ci.yml` (matrix de 8 projects)
