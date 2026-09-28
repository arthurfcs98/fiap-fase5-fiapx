# FIAP X — Contratos entre serviços (fonte da verdade para a implementação)

> Todo agente/serviço implementa exatamente estes nomes. Mudança aqui = mudança coordenada:
> mudou aqui, muda o código no mesmo PR (e vice-versa).

## 1. Serviços

| Serviço | Porta HTTP | Métricas/health internos | Banco |
|---|---|---|---|
| `video-api` | 3000 (prefixo `/api`) | `:9464/health`, `:9464/metrics` | `fiapx_video` |
| `video-worker` | — (sem HTTP público) | `:9464/health`, `:9464/metrics` | nenhum (stateless) |
| `notification-service` | — | `:9464/health`, `:9464/metrics` | `fiapx_notification` |

- `:9464` é interno (nunca publicado na borda). `/health` é aberto; `/metrics` exige `Authorization: Bearer <METRICS_TOKEN>` quando `METRICS_TOKEN` está definido.

## 2. RabbitMQ (4.x, vhost `/`)

### Exchanges
| Nome | Tipo | Uso |
|---|---|---|
| `fiapx.events` | topic, durable | Todos os eventos de domínio e de processamento |
| `fiapx.dlx` | direct, durable | Dead-letter. Routing key = nome da fila de origem |

### Filas (todas **quorum**, durable)
| Fila | Bindings | Consumidor | Argumentos |
|---|---|---|---|
| `worker.video-uploaded` | `fiapx.events` / `video.uploaded` | video-worker (prefetch 1) | `x-queue-type=quorum`, `x-delivery-limit=5`, `x-dead-letter-exchange=fiapx.dlx`, `x-dead-letter-routing-key=worker.video-uploaded`, `x-dead-letter-strategy=at-least-once`, `x-overflow=reject-publish` |
| `worker.video-uploaded.retry.1` / `.retry.2` / `.retry.3` | — (publicação direta pela default exchange) | — (expira e volta) | `x-message-ttl` = 5000 / 30000 / 120000, `x-dead-letter-exchange=""`, `x-dead-letter-routing-key=worker.video-uploaded`, `x-dead-letter-strategy=at-least-once`, `x-overflow=reject-publish` |
| `worker.video-uploaded.dlq` | `fiapx.dlx` / `worker.video-uploaded` | ninguém (parking, inspeção/redrive) | quorum |
| `api.video-deadletter` | `fiapx.dlx` / `worker.video-uploaded` | video-api → marca FAILED `P0099` | quorum, mesmo padrão de retry/DLQ |
| `api.video-processing` | `fiapx.events` / `video.processing.*` | video-api (prefetch 10) | quorum + retry `.retry.1..3` + DLQ `api.video-processing.dlq` |
| `notification.events` | `fiapx.events` / `video.failed`, `video.completed` | notification-service (prefetch 5) | quorum + retry `.retry.1..3` + DLQ `notification.events.dlq` |

- Topologia declarada em código (`libs/messaging/src/topology.ts`), aplicada de forma idempotente no startup de cada serviço **e** por um Job/one-shot `rabbitmq-init` antes dos serviços. Toda fila é declarada com `durable: true` (quorum exige).
- As routing keys não são redefinidas em `libs/messaging`: `ROUTING_KEYS` é o próprio `EVENT_TYPES` de `libs/contracts`.
- Filas `.retry.N` têm TTL fixo por fila (sem head-of-line blocking).

### Regras de consumo (corrige o bug da Fase 4)
1. `ack` só depois do efeito durável (commit no banco, zip gravado, e-mail enviado).
2. `RetryableError` (transitório): se `x-retry-count < 3` → publica cópia em `<fila>.retry.<n+1>` via default exchange com header `x-retry-count = n+1` (publisher confirm) e dá `ack` no original. Se esgotou → `nack(requeue=false)` → DLX.
3. `NonRetryableError` (permanente): trata como resultado de negócio (ex.: worker publica `video.processing.failed`) e dá `ack`. Envelope inválido → `nack(requeue=false)`.
4. Crash no meio: sem ack, o broker reentrega; `x-delivery-limit=5` evita loop infinito (poison message → DLX).
5. Publicação sempre com **publisher confirms**, `persistent: true`, `messageId`, `correlationId`, `type`, `contentType: application/json`, `timestamp`.

### Envelope (JSON no corpo)
```ts
interface EventEnvelope<T> {
  id: string;            // uuid v4 — igual ao AMQP messageId
  type: string;          // = routing key, ex. "video.uploaded"
  version: 1;
  occurredAt: string;    // ISO-8601
  correlationId: string; // atravessa HTTP → outbox → AMQP → worker → e-mail (1 a 100 caracteres)
  payload: T;
}
```
Validado com zod em `libs/contracts` (schemas + tipos). As fixtures v1 ficam fora do barrel de produção: `@fiapx/contracts/fixtures` (só testes).

### Correlation id
- HTTP: header `x-correlation-id`. Valor aceito da borda: `[A-Za-z0-9._:-]{1,100}`; fora disso (ou ausente) a API gera um UUID v4. O id volta no header da resposta e no corpo de erro (`correlationId`).
- Limite de **100** caracteres = coluna `outbox_events.correlation_id varchar(100)` (constante `CORRELATION_ID_MAX_LENGTH` em `libs/contracts`, usada também pelo resolvedor de `libs/observability`).
- AMQP: propriedade `correlationId` da mensagem (regra 5 acima); o header `x-correlation-id` leva o mesmo valor e é preservado nas cópias de retry. O consumidor roda o handler em `runWithCorrelation(id, fn)`.

### Headers AMQP (`libs/messaging/src/headers.ts`)
| Header | Quem grava | Conteúdo |
|---|---|---|
| `x-correlation-id` | publicador (preservado no retry) | correlation id do envelope |
| `x-retry-count` | consumidor, na cópia para `.retry.N` | tentativas de retry já feitas (ausente ou inválido = 0) |
| `x-last-error` | consumidor, na cópia para `.retry.N` | causa da última falha transitória, truncada em 256 caracteres |

### Eventos
| Routing key | Publicado por | Payload |
|---|---|---|
| `video.uploaded` | video-api (outbox) | `{ videoId, userId, originalName, rawBucket, rawKey, zipBucket, zipKey, sizeBytes }` |
| `video.processing.started` | video-worker | `{ videoId, attempt, workerId }` |
| `video.processing.completed` | video-worker | `{ videoId, zipKey, frameCount, zipSizeBytes, durationMs }` |
| `video.processing.failed` | video-worker | `{ videoId, attempt, errorCode, errorMessage }` |
| `video.failed` | video-api (outbox) | `{ videoId, userId, userEmail, userName, originalName, errorCode, errorMessage }` |
| `video.completed` | video-api (outbox) | `{ videoId, userId, userEmail, userName, originalName, frameCount }` |

## 3. Máquina de estados (dona: video-api)

```
QUEUED ──started──► PROCESSING ──completed──► COMPLETED (terminal)
   │                    │   ▲
   │                    │   └── started (retry, attempt+1)
   │                    └──failed──► FAILED (terminal)
   └──── dead-letter (P0099) ───────► FAILED
```
- Transição inválida (ex.: `started` depois de `COMPLETED`) é ignorada com log + ack (idempotência).
- Cada transição grava `video_status_history` e, para COMPLETED/FAILED, um evento no outbox **na mesma transação**.

## 4. Códigos de erro (padrão `AppError` das fases anteriores)
- **A** Auth: `A0001 INVALID_CREDENTIALS`, `A0002 EMAIL_ALREADY_REGISTERED`, `A0003 UNAUTHORIZED`.
- **V** Video: `V0001 VIDEO_NOT_FOUND`, `V0002 UNSUPPORTED_FORMAT`, `V0003 FILE_TOO_LARGE`, `V0004 VIDEO_NOT_READY`, `V0005 INVALID_DOWNLOAD_SIGNATURE`.
- **P** Processamento (gravado em `videos.error_code`): `P0001 INVALID_VIDEO`, `P0002 NO_FRAMES`, `P0003 VIDEO_TOO_LONG`, `P0004 FFMPEG_TIMEOUT`, `P0005 SOURCE_NOT_FOUND`, `P0098 RETRIES_EXHAUSTED`, `P0099 PROCESSING_ABORTED` (dead-letter).
- **X** Comum: `X0001 VALIDATION`, `X0002 INTERNAL`, `X0003 UNAVAILABLE`.
- **Faixa `X0<status HTTP>`** (ex.: `X0404 NOT_FOUND`, `X0429 TOO_MANY_REQUESTS`, `X0503 SERVICE_UNAVAILABLE`): fallback do filtro global para `HttpException` genérica sem código de catálogo. Exceções mapeadas para o catálogo: 401 genérico (Passport/guards) → `A0003 UNAUTHORIZED`; 413 genérico (parser/multer/busboy) → `V0003 FILE_TOO_LARGE`; `message` em array (validação) → `X0001 VALIDATION`.
- Log: 5xx em `error` com stack; 503 em `warn` sem stack (dependência fora, ex.: readiness durante queda do banco).

## 5. Banco `fiapx_video` (video-api, migrações TypeORM em SQL, `synchronize: false`)
```sql
CREATE EXTENSION IF NOT EXISTS citext;
CREATE TYPE video_status AS ENUM ('QUEUED','PROCESSING','COMPLETED','FAILED');

CREATE TABLE users (
  id uuid PRIMARY KEY, name varchar(120) NOT NULL, email citext NOT NULL UNIQUE,
  password_hash varchar(100) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE videos (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  original_name varchar(255) NOT NULL, size_bytes bigint NOT NULL, content_type varchar(100),
  raw_key varchar(300) NOT NULL, zip_key varchar(300),
  status video_status NOT NULL DEFAULT 'QUEUED', attempts int NOT NULL DEFAULT 0,
  frame_count int, zip_size_bytes bigint, error_code varchar(10), error_message varchar(500),
  idempotency_key varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz, completed_at timestamptz,
  UNIQUE (user_id, idempotency_key));
CREATE INDEX ix_videos_user_created ON videos (user_id, created_at DESC);

CREATE TABLE video_status_history (
  id bigserial PRIMARY KEY, video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  from_status video_status, to_status video_status NOT NULL, reason varchar(200),
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY, aggregate_id uuid NOT NULL, event_type varchar(100) NOT NULL,
  payload jsonb NOT NULL, correlation_id varchar(100) NOT NULL,  -- = CORRELATION_ID_MAX_LENGTH
  created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
  attempts int NOT NULL DEFAULT 0, last_error varchar(500), locked_until timestamptz);
CREATE INDEX ix_outbox_pending ON outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE processed_messages (
  message_id uuid NOT NULL, consumer varchar(100) NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, consumer));
```
- Outbox relay: a cada 500 ms, `SELECT … FOR UPDATE SKIP LOCKED LIMIT 50` com lease (`locked_until`), publica com confirm, marca `published_at`. Várias réplicas do api sem duplicar.

## 6. Banco `fiapx_notification` (notification-service)
```sql
CREATE TABLE notifications (
  id uuid PRIMARY KEY, dedup_key varchar(200) NOT NULL UNIQUE,  -- ex. VIDEO_FAILED:<videoId>
  type varchar(40) NOT NULL, recipient varchar(255) NOT NULL, subject varchar(255) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'PENDING',  -- PENDING | SENT | FAILED
  attempts int NOT NULL DEFAULT 0, provider_message_id varchar(100), last_error varchar(500),
  payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz);
```

## 7. Object storage (Garage, S3-compatível, buckets privados)
- Buckets: `fiapx-raw` (vídeos enviados), `fiapx-zips` (resultados).
- Chaves: raw `{userId}/{videoId}{ext}`; zip `{userId}/{videoId}.zip` (determinística → idempotência do worker).
- Metadados do zip: `x-amz-meta-video-id`, `x-amz-meta-frame-count`.
- Cliente: `@aws-sdk/client-s3` + `@aws-sdk/lib-storage`, `forcePathStyle: true`, região `garage`.

## 8. API HTTP (video-api, prefixo `/api`, JWT Bearer HS256)
| Método e rota | Auth | Resposta |
|---|---|---|
| `POST /api/auth/register` `{name,email,password}` | pública, throttle | `201 {id,name,email}` · `409 A0002` |
| `POST /api/auth/login` `{email,password}` | pública, throttle 5/min | `200 {accessToken,tokenType:"Bearer",expiresIn}` · `401 A0001` |
| `GET /api/auth/me` | JWT | `200 {id,name,email}` |
| `POST /api/videos` multipart campo `video` (1 arquivo/request), header opcional `Idempotency-Key` | JWT, throttle | `202 {id,originalName,status:"QUEUED"}` · `400 V0002` · `413 V0003` |
| `GET /api/videos?page=1&limit=20&status=` | JWT | `200 {items:[…],total,page,limit}` só do usuário |
| `GET /api/videos/:id` | JWT + dono | `200 {…, history:[…]}` · `404 V0001` |
| `POST /api/videos/:id/download-url` | JWT + dono | `200 {url, expiresAt}` (HMAC, 5 min) · `409 V0004` |
| `GET /api/downloads/:id?exp=&sig=` | assinatura | stream `application/zip` · `403 V0005` |
| `GET /api/health/live` · `GET /api/health/ready` | pública | `{status, service, version}` · ready checa Postgres + storage (não RabbitMQ) |
| `GET /api/docs` | pública | Swagger |
| `GET /` | pública | frontend estático (login, cadastro, upload múltiplo, tabela com polling 3 s, download) |

- Upload: streaming (busboy) direto para o storage, limite `MAX_UPLOAD_MB` (padrão 95, limite do proxy da Cloudflare), extensões do projeto base (`.mp4 .avi .mov .mkv .wmv .flv .webm`) + checagem de magic bytes. Fluxo: PUT no storage → transação (INSERT video + outbox `video.uploaded`) → `202`.

## 9. Worker (pipeline por mensagem)
1. Valida envelope (zod). 2. `HEAD` do zip: se já existe → republica `completed`, ack. 3. Publica `started`. 4. Baixa raw para `/work/<videoId>/`. 5. `ffprobe` (timeout, duração máx. `MAX_VIDEO_DURATION_S`). 6. `nice -n 10 ffmpeg -nostdin -protocol_whitelist file -i source -vf fps=1 -threads 2 frames/frame_%04d.png` com timeout `FFMPEG_TIMEOUT_MS` (mesma semântica do projeto base). 7. Zip em streaming (`archiver`, store) → `lib-storage Upload`. 8. Publica `completed` com confirm → ack. 9. `finally`: limpa `/work/<videoId>`. SIGTERM: para de consumir e termina o job atual.

## 10. Variáveis de ambiente
| Variável | Serviços | Exemplo |
|---|---|---|
| `NODE_ENV`, `APP_VERSION`, `LOG_LEVEL`, `METRICS_PORT` | todos | `production`, `sha-abc1234`, `info`, `9464` |
| `METRICS_HOST`, `METRICS_TOKEN` | todos | `0.0.0.0`, token ≥ 16 caracteres (se definido, `/metrics` exige Bearer) |
| `PORT`, `SWAGGER_ENABLED` | api | `3000`, `true` |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_SSL` | api, notification | `postgres`, `5432`, …, `fiapx_video`, `false` |
| `RABBITMQ_URL` | todos | `amqp://fiapx:***@rabbitmq:5672` |
| `REDIS_URL` | api | `redis://:***@redis:6379` |
| `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_RAW`, `S3_BUCKET_ZIPS`, `S3_FORCE_PATH_STYLE` | api, worker | `http://garage:3900`, `garage`, …, `fiapx-raw`, `fiapx-zips`, `true` |
| `JWT_SECRET`, `JWT_EXPIRES_IN`, `DOWNLOAD_URL_SECRET`, `PUBLIC_BASE_URL`, `MAX_UPLOAD_MB`, `CORS_ORIGIN` | api | …, `3600`, …, `https://fiapx.asdevit.com`, `95` |
| `WORKER_PREFETCH`, `WORK_DIR`, `FFMPEG_TIMEOUT_MS`, `MAX_VIDEO_DURATION_S` | worker | `1`, `/work`, `600000`, `600` |
| `EMAIL_PROVIDER` (`resend`\|`smtp`\|`log`), `RESEND_API_KEY`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `EMAIL_TO_OVERRIDE`, `NOTIFY_ON_SUCCESS` | notification | `resend`, …, `FIAP X <fiapx@asdevit.com>`, `mailpit`, `1025`, vazio, `true` |
| `HEALTH_URL` | imagem (healthcheck do Docker) | opcional; padrão derivado do app: api `http://127.0.0.1:${PORT}/api/health/live`, demais `http://127.0.0.1:${METRICS_PORT}/health` |

- Segredos por arquivo: toda variável do schema de config aceita `<VAR>_FILE=/caminho` (ex.: `METRICS_TOKEN_FILE`, `S3_SECRET_ACCESS_KEY_FILE`); definir `<VAR>` e `<VAR>_FILE` juntos é erro.
- Valor vazio (`VAR=`) conta como ausente (vale o padrão do schema).

## 11. Métricas Prometheus (prefixo `fiapx_`)
- `fiapx_videos_uploaded_total`, `fiapx_videos_completed_total`, `fiapx_videos_failed_total{error_code}` (api)
- `fiapx_outbox_pending` (gauge, api)
- `fiapx_video_processing_duration_seconds` (histogram), `fiapx_worker_in_flight` (gauge), `fiapx_worker_jobs_total{result}` (worker)
- `fiapx_messages_consumed_total{queue,result}` (todos, via `libs/messaging`)
- `fiapx_notifications_total{type,status}` (notification)
- Mais default metrics do `prom-client` e métricas do RabbitMQ (`rabbitmq_prometheus`, porta 15692).
