# FIAP Frames — Contratos entre serviços (fonte da verdade para a implementação)

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
| `worker.video-uploaded.dlq` | `fiapx.dlx` / `worker.video-uploaded` | ninguém (parking, inspeção; o api já marcou o vídeo como FAILED, então esta DLQ é **purgada**, não re-enviada) | quorum |
| `api.video-deadletter` | `fiapx.dlx` / `worker.video-uploaded` | video-api → marca FAILED `P0098` (retries esgotados: morte `rejected`) ou `P0099` (crash em loop `delivery_limit` ou outro motivo) | quorum, mesmo padrão de retry/DLQ, com **ciclo de retry próprio** (o `x-retry-count` herdado do worker não conta: regra 2) |
| `api.video-processing` | `fiapx.events` / `video.processing.*` | video-api (prefetch 10) | quorum + retry `.retry.1..3` + DLQ `api.video-processing.dlq` |
| `notification.events` | `fiapx.events` / `video.failed`, `video.completed`, `user.deleted` | notification-service (prefetch 5) | quorum + retry `.retry.1..3` + DLQ `notification.events.dlq` |

- Topologia declarada em código (`libs/messaging/src/topology.ts`), aplicada de forma idempotente no startup de **cada** serviço (todos declaram a topologia inteira, então nenhum publica antes de a fila existir). Toda fila é declarada com `durable: true` (quorum exige). No K8s, o Job `rabbitmq-init` (fase setup, antes dos apps) roda primeiro a **mesma** declaração com o administrador (initContainer `topology`: `node dist/setup-topology.js` da imagem do video-api, `runTopologySetupCli`), porque os usuários por serviço só conseguem **re**declarar: o RabbitMQ só deixa criar fila com dead-letter quem tem `read` na fila e `write` no `fiapx.dlx`. Depois o script do Job cria o usuário de monitoramento do KEDA, **um usuário por serviço** e as operator policies (limites das filas). Fila apagada no K8s → apagar o Job e repetir o deploy da release atual (`infra/k8s/README.md`, seção 8.1): os serviços não a recriam.
- **Usuários por serviço (K8s):** `fiapx-api`, `fiapx-worker`, `fiapx-notification`, sem tag (sem management). `configure` só na topologia do contrato (a redeclaração do startup exige; efeito colateral aceito: permite apagar uma fila da topologia); `read` nas duas exchanges e **só nas filas que o serviço consome** (nenhum lê DLQ); `write` em `amq.default` (cópias de retry), nas filas ligadas por bind e, para api e worker, no `fiapx.events`; ninguém publica no `fiapx.dlx`; **topic permission** no `fiapx.events`: api publica só `video.uploaded|video.completed|video.failed|user.deleted`, worker só `video.processing.*`, notification nada. O administrador `fiapx` é só do broker e do Job. No compose (dev) os 3 apps usam o `fiapx`. Teste: `libs/messaging/test/rabbitmq-permissions.int-spec.ts` (broker real, vazio como um cluster novo).
- **Operator policies (K8s, Job `rabbitmq-init`):** `fiapx-limits` (`.*`, prioridade 0): `max-length-bytes` 64 MiB por fila; `fiapx-dlq-limits` (`\.dlq$`, prioridade 1, vale no lugar da anterior): 64 MiB com `overflow: reject-publish` (nunca descarta a mais antiga calado; com dead-letter at-least-once a mensagem espera na fila de origem) e `message-ttl` de **7 dias** (LGPD: as DLQs guardam e-mail, nome e nome de arquivo). Política não é argumento de fila: muda sem migração.
- **Plugins:** `rabbitmq_shovel` + `rabbitmq_shovel_management` (arquivo `enabled_plugins`, compose e K8s): "Move messages" no management para o redrive das DLQs.
- As routing keys não são redefinidas em `libs/messaging`: `ROUTING_KEYS` é o próprio `EVENT_TYPES` de `libs/contracts`.
- Filas `.retry.N` têm TTL fixo por fila (sem head-of-line blocking).

### Regras de consumo (corrige o bug da Fase 4)
1. `ack` só depois do efeito durável (commit no banco, zip gravado, e-mail enviado).
2. `RetryableError` (transitório): se os retries **do ciclo atual** `< 3` → publica cópia em `<fila>.retry.<n+1>` via default exchange com header `x-retry-count = n+1` (publisher confirm) e dá `ack` no original. Se esgotou → `nack(requeue=false)` → DLX. O ciclo atual é o `x-retry-count` enquanto a mensagem circula entre a fila e as `.retry.N` (volta delas com `x-last-death-reason=expired`); mensagem que **chegou por dead-letter** (`rejected`, `delivery_limit`: ex. `api.video-deadletter`) ou por **redrive de DLQ** começa do 0 (`effectiveRetryCount`).
   2b. **Dependência fora** (`DependencyUnavailableError` ou erro de conexão: Postgres/storage/SMTP/Resend inalcançável, 5xx/429 do provedor): não é culpa da mensagem → `nack(requeue=true)` (no RabbitMQ 4.3 não conta no `x-delivery-limit`) e o consumidor **pausa** (cancela o consumer) com backoff de 5 s dobrando até 60 s; volta a consumir sozinho. Não gasta retry: uma queda longa do Postgres não manda nada para a DLQ. Resultado `deferred` na métrica.
3. `NonRetryableError` (permanente): trata como resultado de negócio (ex.: worker publica `video.processing.failed`) e dá `ack`. Envelope inválido → `nack(requeue=false)`.
4. Crash no meio: sem ack, o broker reentrega; `x-delivery-limit=5` evita loop infinito (poison message → DLX).
5. Publicação sempre com **publisher confirms**, `persistent: true`, `messageId`, `correlationId`, `type`, `contentType: application/json`, `timestamp`.
6. **Canal fechado no meio do processamento** (queda do broker, reconexão): cada entrega carrega um `signal` (`MessageContext.signal`) que aborta quando o canal dela fecha. Depois disso nada é confirmado nem publicado (nem cópia de retry, nem resultado): o broker já vai reentregar (resultado `aborted`). O worker mata ffprobe/ffmpeg e aborta as transferências. Entregas com o **mesmo `messageId`** rodam uma depois da outra no processo (a reentrega espera a antiga terminar).
7. **Consumer cancelado pelo broker** (fila apagada/recriada, `consumer_timeout`): o consumidor declara a topologia de novo e re-assina com backoff (1 s → 30 s). Se ficar sem consumer por mais de 60 s com o broker conectado (e sem pausa proposital), o `/health` da porta 9464 responde 503 (`failing: ["messaging-consumers"]`) e o Kubernetes reinicia o pod (worker e notification; no api, só o alerta `FiapxQueueWithoutConsumer`).

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
| `x-origin-death-reason` | consumidor, na cópia para `.retry.N` de uma mensagem que chegou por dead-letter | motivo original (`rejected`, `delivery_limit`): a cópia perde o `x-death` e volta da `.retry.N` como `expired`, e o api ainda precisa dele para escolher P0098/P0099 |

### Eventos
| Routing key | Publicado por | Payload |
|---|---|---|
| `video.uploaded` | video-api (outbox) | `{ videoId, userId, originalName, rawBucket, rawKey, zipBucket, zipKey, sizeBytes }` |
| `video.processing.started` | video-worker | `{ videoId, attempt, workerId }` |
| `video.processing.completed` | video-worker | `{ videoId, zipKey, frameCount, zipSizeBytes, durationMs }` |
| `video.processing.failed` | video-worker | `{ videoId, attempt, errorCode, errorMessage }` |
| `video.failed` | video-api (outbox) | `{ videoId, userId, userEmail, userName, originalName, errorCode, errorMessage }` |
| `video.completed` | video-api (outbox) | `{ videoId, userId, userEmail, userName, originalName, frameCount }` |
| `user.deleted` | video-api (outbox, na transação do `DELETE /api/me`) | `{ userId }` |

## 3. Máquina de estados (dona: video-api)

```
QUEUED ──started──► PROCESSING ──completed──► COMPLETED (terminal)
   │                    │   ▲
   │                    │   └── started (retry, attempt+1)
   │                    └──failed──► FAILED (terminal)
   └──── dead-letter (P0098/P0099) ─► FAILED
```
- Transição inválida (ex.: `started` depois de `COMPLETED`) é ignorada com log + ack (idempotência).
- Cada transição grava `video_status_history` e, para COMPLETED/FAILED, um evento no outbox **na mesma transação**.

## 4. Códigos de erro (padrão `AppError` das fases anteriores)
- **A** Auth: `A0001 INVALID_CREDENTIALS`, `A0002 EMAIL_ALREADY_REGISTERED`, `A0003 UNAUTHORIZED`, `A0004 INVALID_PASSWORD_CONFIRMATION` (400, `DELETE /api/me` com a senha errada).
- **V** Video: `V0001 VIDEO_NOT_FOUND`, `V0002 UNSUPPORTED_FORMAT`, `V0003 FILE_TOO_LARGE`, `V0004 VIDEO_NOT_READY`, `V0005 INVALID_DOWNLOAD_SIGNATURE`, `V0006 ZIP_EXPIRED` (410, zip removido pela retenção), `V0007 TOO_MANY_PENDING_VIDEOS` (429 + `Retry-After` 15 s: o usuário já tem `MAX_PENDING_VIDEOS_PER_USER` vídeos em andamento).
- **P** Processamento (gravado em `videos.error_code`): `P0001 INVALID_VIDEO`, `P0002 NO_FRAMES`, `P0003 VIDEO_TOO_LONG` (duração do ffprobe ou, sem duração no cabeçalho, mais frames que `MAX_VIDEO_DURATION_S`), `P0004 FFMPEG_TIMEOUT`, `P0005 SOURCE_NOT_FOUND`, `P0006 OUTPUT_TOO_LARGE` (os frames passam de `MAX_FRAMES_MB` ou não cabem no disco de trabalho do worker, ENOSPC: sem retry), `P0007 STORAGE_FULL` (bucket de zips na quota: sem retry), `P0098 RETRIES_EXHAUSTED` (dead-letter por retries esgotados), `P0099 PROCESSING_ABORTED` (dead-letter por crash em loop ou outro motivo). Erro de entrada: P0001-P0006; erro do sistema (SLO do pipeline): P0007, P0098, P0099.
- **X** Comum: `X0001 VALIDATION`, `X0002 INTERNAL`, `X0003 UNAVAILABLE` (503 + `Retry-After`: storage fora ou bucket de originais cheio no upload, réplica com `MAX_CONCURRENT_UPLOADS` uploads em andamento, **dependência inalcançável** como o Postgres fora, inclusive ao validar o JWT, que nunca vira 401 por isso).
- **Faixa `X0<status HTTP>`** (ex.: `X0404 NOT_FOUND`, `X0429 TOO_MANY_REQUESTS`, `X0503 SERVICE_UNAVAILABLE`): fallback do filtro global para `HttpException` genérica sem código de catálogo. Exceções mapeadas para o catálogo: 401 genérico (Passport/guards) → `A0003 UNAUTHORIZED`; 413 genérico (parser/multer/busboy) → `V0003 FILE_TOO_LARGE`; `message` em array (validação) → `X0001 VALIDATION`.
- Log: 5xx em `error` com stack; 503 em `warn` sem stack (dependência fora, ex.: queda do banco).
- O corpo de erro traz `path` **sem a query string** (a do download tem a assinatura).

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
CREATE INDEX ix_video_status_history_video ON video_status_history (video_id);  -- migração 1790640000000

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
- Outbox relay: a cada 500 ms, `SELECT … FOR UPDATE SKIP LOCKED LIMIT 50` com lease de 30 s (`locked_until`), publica com confirm, marca `published_at`. Nenhuma publicação começa nos últimos 10 s do lease (o resto do lote é devolvido), então duas réplicas não publicam a mesma linha em operação normal; entrega continua at-least-once (crash entre o confirm e o UPDATE), e os consumidores deduplicam.

## 6. Banco `fiapx_notification` (notification-service)
```sql
CREATE TABLE notifications (
  id uuid PRIMARY KEY, dedup_key varchar(200) NOT NULL UNIQUE,  -- ex. VIDEO_FAILED:<videoId>
  type varchar(40) NOT NULL, recipient varchar(255) NOT NULL, subject varchar(255) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'PENDING',  -- PENDING | SENT | FAILED
  attempts int NOT NULL DEFAULT 0, provider_message_id varchar(100), last_error varchar(500),
  payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz);
-- migração 1790640000000 (LGPD e orçamento de e-mails):
CREATE TABLE deleted_users (user_id uuid PRIMARY KEY, deleted_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX ix_notifications_created ON notifications (created_at);
```
- `deleted_users`: gravada na MESMA transação da anonimização do `user.deleted`; um `video.*` do usuário que chegar depois (corrida com prefetch 5, retry ou redrive) não é registrado nem enviado. Registro e anonimização são serializados por usuário (`pg_advisory_xact_lock`). Só UUIDs; linhas com mais de `NOTIFICATION_RETENTION_DAYS` saem no job diário.
- Orçamento: uma notificação NOVA acima de `NOTIFICATION_DAILY_LIMIT_PER_USER` (do usuário) ou `NOTIFICATION_DAILY_LIMIT` (total) em 24 h não é registrada nem enviada (métrica `SKIPPED`).

## 7. Object storage (Garage, S3-compatível, buckets privados)
- Buckets: `fiapx-raw` (vídeos enviados), `fiapx-zips` (resultados).
- Chaves: raw `{userId}/{videoId}{ext}`; zip `{userId}/{videoId}.zip` (determinística → idempotência do worker).
- Metadados do zip: `x-amz-meta-video-id`, `x-amz-meta-frame-count`.
- Cliente: `@aws-sdk/client-s3` + `@aws-sdk/lib-storage`, `forcePathStyle: true`, região `garage`. Uploads do api em partes de 5 MiB, 1 em voo (~10 MiB de buffer por upload); worker 8 MiB × 2.
- Quotas por bucket (K8s, Job `garage-init`): `fiapx-raw` 1 GiB, `fiapx-zips` 2,5 GiB. Quota estourada → `StorageQuotaExceededError` (`403` "quota" do Garage): no upload vira `503 X0003` (`Retry-After` 30 s); no zip do worker, `P0007` sem retry. `fiapx_zip_storage_bytes` e o alerta `FiapxZipStorageHigh` avisam antes.

## 8. API HTTP (video-api, prefixo `/api`, JWT Bearer HS256)
| Método e rota | Auth | Resposta |
|---|---|---|
| `POST /api/auth/register` `{name,email,password,acceptPrivacyPolicy}` | pública, throttle 10/h por IP | `201 {id,name,email}` · `400 X0001` (sem aceite; nome com endereço de site: `://` ou `www.`) · `409 A0002` |
| `POST /api/auth/login` `{email,password}` | pública, throttle 5/min por IP + e-mail **e** 30/min por IP (qualquer e-mail) | `200 {accessToken,tokenType:"Bearer",expiresIn}` · `401 A0001` · `429 X0429` (+ `Retry-After`) |
| `GET /api/auth/me` | JWT | `200 {id,name,email}` |
| `POST /api/videos` multipart campo `video` (1 arquivo/request), header opcional `Idempotency-Key` | JWT, throttle 30/min por usuário | `202 {id,originalName,status:"QUEUED"}` · `400 V0002` · `413 V0003` · `429 V0007` (+ `Retry-After`) · `503 X0003` (+ `Retry-After`) |
| `GET /api/videos?page=1&limit=20&status=` | JWT | `200 {items:[…],total,page,limit}` só do usuário (item: `id, originalName, sizeBytes, contentType, status, attempts, frameCount, zipSizeBytes, errorCode, errorMessage, createdAt, updatedAt, startedAt, completedAt, expiredAt, downloadAvailable`) |
| `GET /api/videos/:id` | JWT + dono | `200 {…, history:[…]}` · `404 V0001` |
| `POST /api/videos/:id/download-url` | JWT + dono | `200 {url, expiresAt}` (HMAC, 5 min) · `409 V0004` · `410 V0006` |
| `GET /api/downloads/:id?exp=&sig=` | assinatura | stream `application/zip` · `403 V0005` · `410 V0006` |
| `GET /api/me/data` | JWT | `200 {exportedAt, user, videos:[{…, history}]}` (seção 12), `Content-Disposition: attachment; filename="fiap-frames-meus-dados.json"` |
| `DELETE /api/me` `{password}` | JWT, throttle 5/min por usuário | `204` · `400 A0004` (seção 12) |
| `GET /api/health/live` · `GET /api/health/ready` | pública | `{status, service, version}` · ready checa Postgres + storage (não RabbitMQ), resultado reaproveitado por 2 s: `200 {status:"ok",service,version}` ou `503 {status:"unavailable",service,version}`, **sem** o motivo (fica só no log: hosts e usuário do banco não saem numa rota pública) |
| `GET /api/docs` | pública | Swagger |
| `GET /` | pública | frontend estático (login, cadastro, upload múltiplo, tabela com polling 3 s, download) |

- Throttling em Redis (fail-open se o Redis cair); os limites de cadastro, login e upload são ajustáveis por `THROTTLE_*_LIMIT` (seção 10), com os valores acima como padrão.
- Upload: streaming (busboy) direto para o storage, limite `MAX_UPLOAD_MB` (padrão 95, em MiB, abaixo do limite de 100 MB do proxy da Cloudflare), extensões do projeto base (`.mp4 .avi .mov .mkv .wmv .flv .webm`) + checagem de magic bytes. Fluxo: PUT no storage → transação (INSERT video + outbox `video.uploaded`) → `202`.
- Antes de ler o corpo: vídeos em andamento do usuário (QUEUED/PROCESSING no banco + uploads dele em curso na réplica) `>= MAX_PENDING_VIDEOS_PER_USER` → `429 V0007`; a réplica já com `MAX_CONCURRENT_UPLOADS` uploads em streaming → `503 X0003` (o limite de memória do pod). O frontend espera e tenta de novo pelo `Retry-After` (V0007 é uma espera normal, não um erro).

## 9. Worker (pipeline por mensagem)
1. Valida envelope (zod). 2. `HEAD` do zip: se já existe → republica `completed`, ack. 3. Publica `started`. 4. Baixa raw para `/work/<videoId>/<runId>/` (uma pasta **por execução**: a reentrega da mesma mensagem nunca mexe nos arquivos de uma execução que ainda está terminando). 5. `ffprobe -format_whitelist mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,asf,flv` (timeout, duração máx. `MAX_VIDEO_DURATION_S`). 6. `nice -n 10 ffmpeg -hide_banner -loglevel error -nostdin -protocol_whitelist file -format_whitelist <a mesma> -i source -vf fps=1,scale=w='min(iw,1920)':h='min(ih,1920)':force_original_aspect_ratio=decrease -frames:v <MAX_VIDEO_DURATION_S + 1> -threads 2 frames/frame_%04d.png` com timeout `FFMPEG_TIMEOUT_MS` (semântica do projeto base, `fps=1` e PNG, com dois limites de saída: no máximo 1 frame por segundo de `MAX_VIDEO_DURATION_S`, mesmo sem duração no cabeçalho, e 1920 px no lado maior; mais frames que o limite → `P0003`). Enquanto o ffmpeg roda, a pasta dos frames é medida a cada 1 s: passou de `MAX_FRAMES_MB`, o ffmpeg é parado e o vídeo falha com `P0006` (no K8s um emptyDir cheio despeja o pod em vez de falhar a escrita); disco cheio (ENOSPC) também → `P0006`. 7. Zip em streaming (`archiver`, store) → `lib-storage Upload` (quota → `P0007`). 8. Publica `completed` com confirm → ack. 9. `finally`: limpa a pasta da execução. Canal fechado no meio (regra 6): ffmpeg morto, transferências abortadas, nada publicado. SIGTERM: para de consumir e termina o job atual **inteiro**: o shutdown espera ffprobe + ffmpeg nos seus tempos máximos + transferências (30 + 600 + 60 = 690 s), com grace de 720 s (K8s e compose). No boot, o `WORK_DIR` (exclusivo da réplica) é esvaziado: sobras de um processo morto não comem o disco do próximo job.

## 10. Variáveis de ambiente
| Variável | Serviços | Exemplo |
|---|---|---|
| `NODE_ENV`, `APP_VERSION`, `LOG_LEVEL`, `METRICS_PORT` | todos | `production`, `sha-abc1234`, `info`, `9464` |
| `METRICS_HOST`, `METRICS_TOKEN` | todos | `0.0.0.0`, token ≥ 16 caracteres (se definido, `/metrics` exige Bearer) |
| `PORT`, `SWAGGER_ENABLED` | api | `3000`, `true` |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_SSL` | api, notification | `postgres`, `5432`, …, `fiapx_video`, `false` |
| `RABBITMQ_URL` | todos | `amqp://fiapx:***@rabbitmq:5672` (compose); no K8s, um usuário por serviço (`fiapx-api`, `fiapx-worker`, `fiapx-notification`, seção 2) |
| `REDIS_URL` | api | `redis://:***@redis:6379` |
| `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_RAW`, `S3_BUCKET_ZIPS`, `S3_FORCE_PATH_STYLE` | api, worker | `http://garage:3900`, `garage`, …, `fiapx-raw`, `fiapx-zips`, `true` |
| `JWT_SECRET`, `JWT_EXPIRES_IN`, `DOWNLOAD_URL_SECRET`, `PUBLIC_BASE_URL`, `MAX_UPLOAD_MB`, `CORS_ORIGIN` | api | …, `3600`, …, `https://frames.asdevit.com`, `95`, `https://frames.asdevit.com` |
| `ZIP_RETENTION_DAYS`, `DATA_RETENTION_INTERVAL_S`, `PRIVACY_POLICY_VERSION` | api | `7` (aceita fração, ex. `0.0005` ≈ 43 s nos testes), `3600` (job de retenção), `2026-09-28` |
| `THROTTLE_REGISTER_LIMIT`, `THROTTLE_LOGIN_LIMIT`, `THROTTLE_LOGIN_IP_LIMIT`, `THROTTLE_UPLOAD_LIMIT` | api | `10` (por hora/IP), `5` (por minuto/IP + e-mail), `30` (por minuto/IP, qualquer e-mail), `30` (por minuto/usuário); o compose local usa `1000`, `5`, `1000`, `600`. IPv6 conta por prefixo `/64` |
| `MAX_CONCURRENT_UPLOADS`, `MAX_PENDING_VIDEOS_PER_USER` | api | `8` (uploads em streaming por réplica; acima, `503 X0003`), `5` (vídeos em andamento por usuário; acima, `429 V0007`); o compose local usa `64`, `1000` |
| `WORKER_PREFETCH`, `WORK_DIR`, `FFMPEG_TIMEOUT_MS`, `MAX_VIDEO_DURATION_S`, `MAX_FRAMES_MB` | worker | `1`, `/work`, `600000`, `600` (também limita os frames: no máximo `MAX_VIDEO_DURATION_S + 1`), `1536` (bytes de frames de um vídeo no `/work`, abaixo do emptyDir de 2 GiB; o compose usa `900`, abaixo do tmpfs de 1 GiB). O shutdown espera `30 s + FFMPEG_TIMEOUT_MS + 60 s` (grace do pod/compose: 720 s) |
| `EMAIL_PROVIDER` (`resend`\|`smtp`\|`log`), `RESEND_API_KEY`, `EMAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `EMAIL_TO_OVERRIDE`, `NOTIFY_ON_SUCCESS` | notification | `resend`, …, `FIAP Frames <frames@asdevit.com>`, `mailpit`, `1025`, vazio, `false` em produção (o enunciado pede e-mail só na falha; o compose usa `true` para o BDD ver o e-mail de sucesso) |
| `PUBLIC_BASE_URL`, `NOTIFICATION_RETENTION_DAYS` | notification | `https://frames.asdevit.com` (link do e-mail), `30` |
| `NOTIFICATION_DAILY_LIMIT_PER_USER`, `NOTIFICATION_DAILY_LIMIT` | notification | `10` (e-mails por usuário em 24 h), `80` (total em 24 h, abaixo da cota do Resend free); o compose local usa `100000` |
| `HEALTH_URL` | imagem (healthcheck do Docker) | opcional; padrão derivado do app: api `http://127.0.0.1:${PORT}/api/health/live`, demais `http://127.0.0.1:${METRICS_PORT}/health` |

- Segredos por arquivo: toda variável do schema de config aceita `<VAR>_FILE=/caminho` (ex.: `METRICS_TOKEN_FILE`, `S3_SECRET_ACCESS_KEY_FILE`); definir `<VAR>` e `<VAR>_FILE` juntos é erro.
- Valor vazio (`VAR=`) conta como ausente (vale o padrão do schema).

## 11. Métricas Prometheus (prefixo `fiapx_`)
- `fiapx_http_request_duration_seconds{method,route,status}` (histogram, api; `route` = padrão do Nest, ex. `/api/videos/:id`)
- `fiapx_videos_uploaded_total`, `fiapx_videos_completed_total`, `fiapx_videos_failed_total{error_code}` (api)
- `fiapx_outbox_pending` (gauge, api)
- `fiapx_video_turnaround_seconds` (histogram, api): do upload até `COMPLETED`, **incluindo a espera na fila** (buckets 10 s a 2 h, 300 s exato para o SLO)
- `fiapx_zip_storage_bytes` (gauge, api): bytes dos zips ainda guardados (soma de `videos.zip_size_bytes` não expirados, lida do banco no scrape)
- `fiapx_video_processing_duration_seconds{result}` (histogram), `fiapx_worker_in_flight` (gauge), `fiapx_worker_jobs_total{result}` (worker; `result` = `completed`, `duplicate`, `failed`, `retry`)
- `fiapx_messages_consumed_total{queue,result}` (todos, via `libs/messaging`; `result` = `success`, `retry`, `dead_letter`, `permanent_failure`, `invalid`, `requeued`, `deferred` (dependência fora, regra 2b), `aborted` (canal fechou, regra 6))
- `fiapx_notifications_total{type,status}` (notification; `type` = `VIDEO_FAILED`, `VIDEO_COMPLETED`; `status` = `SENT`, `FAILED`, `RETRY`, `SKIPPED`)
- Todo código P (`P0001`-`P0007`, `P0098`, `P0099`) nasce em 0 no boot em `fiapx_videos_failed_total`, para o `increase()` do SLO enxergar a primeira falha.
- Toda métrica leva o rótulo `service`. Mais default metrics do `@prometheus-io/client` (sucessor oficial do `prom-client`) e métricas do RabbitMQ (`rabbitmq_prometheus`, porta 15692).

## 12. LGPD (Lei 13.709/2018) — privacidade por padrão

**Dados pessoais tratados:** `users.name`, `users.email`, `users.password_hash` (bcrypt, nunca a senha), o **conteúdo dos vídeos** enviados (pode conter imagem de pessoas) e `notifications.recipient`. Nada além disso é coletado (minimização, art. 6º III).

| Tema | Regra (obrigatória na implementação) |
|---|---|
| **Base legal e transparência** (art. 7º V, art. 9º) | Cadastro exige `acceptPrivacyPolicy: true`. Persistir `users.privacy_accepted_at timestamptz NOT NULL` e `users.privacy_policy_version varchar(20) NOT NULL` (versão atual `2026-09-28`). Página pública `/privacidade.html` (frontend) com: dados coletados, finalidade, retenção, direitos e contato. Sem aceite → `400 X0001`. |
| **Retenção do vídeo original** | O `video-api` apaga o objeto `fiapx-raw` assim que o vídeo chega a `COMPLETED` **ou** `FAILED` (não há reprocessamento no escopo). Rede de segurança no job de retenção (a cada hora, com advisory lock): original de vídeo já terminado → apagado; original sem linha no banco há mais de 1 h → apagado; upload multipart interrompido há mais de 1 h (nos dois buckets) → abortado. |
| **Retenção do zip** | `ZIP_RETENTION_DAYS` (padrão `7`). Job a cada hora no `video-api` (`DATA_RETENTION_INTERVAL_S`, padrão 3600; `@nestjs/schedule`, com `pg_try_advisory_xact_lock` para não rodar em duas réplicas) apaga zips vencidos, grava `videos.zip_key = NULL` e `videos.expired_at = now()`. Download de zip expirado → `410 V0006 ZIP_EXPIRED`. O mesmo job apaga as linhas publicadas do outbox com mais de 7 dias (payloads com e-mail e nome), `processed_messages` com mais de 14 dias e os objetos de usuários que não existem mais (rede de segurança da eliminação). |
| **Retenção de notificações** | Job diário no `notification-service`: notificações com mais de `NOTIFICATION_RETENTION_DAYS` (padrão `30`) ficam com `recipient = 'removido'` e `payload = '{}'`; linhas de `deleted_users` com a mesma idade saem. |
| **Retenção nas filas mortas** | As DLQs (`*.dlq`) guardam envelopes com e-mail, nome e nome de arquivo: operator policy `fiapx-dlq-limits` com `message-ttl` de **7 dias** (seção 2). O runbook manda purgar `worker.video-uploaded.dlq` (o vídeo já é FAILED) e re-enviar as outras. |
| **Acesso e portabilidade** (art. 18 II e V) | `GET /api/me/data` (JWT) → JSON com o usuário (sem hash), todos os vídeos e o histórico de status, baixado como `fiap-frames-meus-dados.json`. Os registros de envio de e-mail (`fiapx_notification`) não entram no arquivo (outro banco); a política de privacidade diz o que eles guardam e como pedir. |
| **Eliminação** (art. 18 VI) | `DELETE /api/me` (JWT, corpo `{ "password": "..." }` para confirmar) → numa transação: apaga `video_status_history`, `videos`, `users` e grava no outbox `user.deleted { userId }`; depois apaga os objetos do usuário nos dois buckets (prefixo `{userId}/`). `204`. Tokens emitidos antes ficam inválidos porque a estratégia JWT confere se o usuário existe. |
| **Propagação da eliminação** | Evento `user.deleted` (`fiapx.events`, payload `{ userId }`), com binding na fila `notification.events`. O `notification-service` anonimiza as notificações daquele `userId` (`recipient = 'removido'`, `payload = '{}'`) e grava o `userId` em `deleted_users` na mesma transação: um `video.*` do usuário que chegar **depois** (corrida com o prefetch, retry, redrive) é descartado sem e-mail (seção 6). Para isso `notifications` ganha `user_id uuid NOT NULL` + índice, e os eventos `video.failed`/`video.completed` já carregam `userId`. |
| **E-mails** | O cadastro não verifica o e-mail (corte do escopo), então o e-mail não pode virar spam para terceiros: nome e nome de arquivo entram no e-mail sem virar link (`linkSafeText`), o nome do cadastro não aceita endereço de site, e há orçamento diário (`NOTIFICATION_DAILY_LIMIT_PER_USER`, `NOTIFICATION_DAILY_LIMIT`, seção 10). |
| **Logs sem dados pessoais** | O pino redige `password`, `authorization`, `cookie`, `email`, `*.email`, `userEmail`, `recipient`, `name`, `userName`, `originalName`. O log de acesso HTTP guarda só `id`, método, **caminho sem query string** (a query do download tem a assinatura), IP e status (sem cabeçalhos: o `Content-Disposition` tem o nome do arquivo). O Postgres roda com `log_error_verbosity=terse` e `log_parameter_max_length=0` (sem `DETAIL: Key (email)=(…)`). Logs de negócio usam **somente IDs** (`userId`, `videoId`). Métricas nunca têm label com dado pessoal. Os logs no Loki ficam 72 h. O BDD (`tests/bdd/features/99-logs-sem-dados-pessoais.feature`) confere os logs de todos os containers. |
| **Segurança** (art. 46) | TLS do navegador até a Cloudflare e da Cloudflare até o Caddy da VM (regra SSL Full (strict) no endereço oficial `frames.asdevit.com`; o host técnico `fiapx.asdevit.com`, usado pelo smoke do deploy, está fora da regra: `infra/vm/README.md`, P13); do Caddy ao Traefik e aos pods o tráfego é HTTP, mas não sai do host (bridge docker interna + rede dos pods, que a internet não alcança: UFW e a guarda `fiapx-netguard`), bcrypt custo 12, JWT com expiração de 1 h, isolamento por dono em toda consulta (`404` para vídeo alheio), buckets privados, Secrets do K8s criptografados em repouso (`secrets-encryption` do K3s), nenhuma credencial no Git (gitleaks no CI e no pre-commit). |
| **Incidentes** (art. 48) | Runbook `docs/runbooks/incidente-dados.md`: como identificar, conter, avaliar e comunicar. |

Documento para a banca: `docs/lgpd.md` (mapa de dados, bases legais, retenção, direitos, medidas de segurança).

Novos códigos de erro: `V0006 ZIP_EXPIRED`, `A0004 INVALID_PASSWORD_CONFIRMATION`.
Novas variáveis: `ZIP_RETENTION_DAYS`, `DATA_RETENTION_INTERVAL_S`, `PRIVACY_POLICY_VERSION` (api), `NOTIFICATION_RETENTION_DAYS` (notification) — seção 10.
Colunas (já na migração inicial de cada banco, porque nada tinha ido para produção antes): `fiapx_video`: `users.privacy_accepted_at`, `users.privacy_policy_version`, `videos.expired_at timestamptz`. `fiapx_notification`: `notifications.user_id uuid NOT NULL` + `ix_notifications_user`. Depois: tabela `deleted_users` e `ix_notifications_created` (migração `1790640000000`, seção 6).

## 13. Observabilidade e SLOs

**Três sinais, tudo no cluster e provisionado como código (`infra/k8s/observability/`):**

| Sinal | Como | Onde ver |
|---|---|---|
| **Métricas** | `@prometheus-io/client` em `:9464/metrics` nos 3 serviços (§11) + `fiapx_http_request_duration_seconds{method,route,status}` (histogram) no `video-api` + RabbitMQ `:15692` (`rabbitmq_prometheus`) + métricas do KEDA. Prometheus com service discovery por anotação `prometheus.io/scrape`. Retenção 3 dias (os SLIs de 7 dias valem, na prática, para os últimos 3 dias: `docs/observabilidade.md`, seção 5). | Grafana → dashboards |
| **Logs** | pino JSON (stdout) com `correlationId`, `service`, `level`. **Grafana Alloy** (DaemonSet, sucessor do Promtail, que foi descontinuado) lê os logs dos pods pela API do Kubernetes (sem hostPath) e envia ao **Loki** (single binary, retenção 72 h). Rótulos: só `namespace`, `app`, `level`; `correlationId` vai como structured metadata. | Grafana → Explore: `{namespace="fiapx"} \| json \| correlationId="<id>"` mostra o caminho HTTP → outbox → worker → e-mail |
| **Rastreamento de ponta a ponta** | `correlationId` atravessa HTTP → outbox → AMQP (`correlationId` do AMQP + envelope) → worker → notification. | Mesmo filtro no Loki |

**Dashboards (Grafana, provisionados):** `FIAP Frames — Pipeline de vídeos` (uploads/min, mensagens prontas e em processamento em `worker.video-uploaded`, réplicas do worker (KEDA), duração p50/p95, falhas por `error_code`, outbox pendente, DLQs, e-mails enviados, CPU/memória por pod) e `FIAP Frames — SLOs` (os indicadores abaixo com a meta e o orçamento de erro).

**SLOs (janela de 7 dias):**

| SLI | SLO | Consulta base |
|---|---|---|
| Disponibilidade da API | ≥ 99,5% das requisições sem 5xx | `fiapx_http_request_duration_seconds_count` |
| Aceite do upload | p95 de `POST /api/videos` < 5 s | histograma HTTP, `route="/api/videos"` |
| Tempo de processamento | p95 < 120 s (vídeos até 60 s) | `fiapx_video_processing_duration_seconds` |
| Tempo até o resultado | 95% dos vídeos em `COMPLETED` até 300 s depois do upload (inclui a espera na fila, que o SLO anterior não vê) | `fiapx_video_turnaround_seconds` |
| Sucesso do pipeline | ≥ 99% dos vídeos válidos em `COMPLETED` (falhas `P0007`/`P0098`/`P0099` contam como erro do sistema; `P0001`–`P0006` são erro de entrada e ficam fora) | `fiapx_videos_completed_total`, `fiapx_videos_failed_total{error_code}` |
| Nenhuma requisição perdida | DLQs vazias e outbox pendente < 100 por mais de 5 min | `rabbitmq_queue_messages{queue=~".*dlq"}`, `fiapx_outbox_pending` |

**Alertas (regras do Prometheus, visíveis no Grafana; sem Alertmanager, ninguém é notificado fora do Grafana):** `FiapxApiErrorRateHigh`, `FiapxUploadLatencyHigh`, `FiapxProcessingSlow`, `FiapxDlqNotEmpty`, `FiapxOutboxBacklog`, `FiapxQueueBacklogHigh`, `FiapxQueueWithoutConsumer` (fila principal sem consumer por 5 min), `FiapxZipStorageHigh` (zips acima de 2 GiB, quota 2,5 GiB), `FiapxWorkerDown`, `FiapxTargetDown`.

**Health dos consumidores:** worker e notification respondem `/health` na porta de métricas com 503 quando o consumidor está sem consumer há mais de 60 s com o broker conectado (seção 2, regra 7); a liveness do K8s usa esse endpoint.

Documento: `docs/observabilidade.md` (arquitetura dos três sinais, SLOs, alertas, como investigar um vídeo pelo `correlationId`).

## 14. Marca (decisão do Arthur, 2026-09-28)

- **Nome do produto visível ao usuário: "FIAP Frames"** (título das páginas, logo, e-mails, Swagger `title`, README na parte de produto). **Sem "X" no nome e sem vermelho/magenta na identidade.**
- "FIAP X" continua só como a **empresa fictícia do enunciado** (contexto nos docs: "a FIAP X contratou…"), nunca como marca na interface.
- Paleta: azul como cor principal (`--brand #2f5bd3`, hover `#2447a8`); vermelho só para estados de erro (`FAILED`).
- Ícone: película com "play" em fundo azul (`apps/video-api/public/favicon.svg`).
- Remetente dos e-mails: `FIAP Frames <frames@asdevit.com>` (`EMAIL_FROM`).
- **Endereço público oficial: `https://frames.asdevit.com`** (DNS proxied na Cloudflare + `infra/vm/frames.caddy`, que repassa ao Traefik com `Host: fiapx.asdevit.com`). Em produção: `PUBLIC_BASE_URL=https://frames.asdevit.com` e `CORS_ORIGIN=https://frames.asdevit.com`. Links de e-mail, docs, README e roteiro do vídeo usam **frames.asdevit.com**. O Ingress continua respondendo a `fiapx.asdevit.com` (host interno usado pelo Caddy e pelo smoke do `deploy.sh`).
- Identificadores técnicos continuam `fiapx` (namespace K8s, imagens `fiapx-*`, métricas `fiapx_*`, repo, domínio `fiapx.asdevit.com`) para não quebrar a infra já instalada.

## 15. Ambiente local (compose), testes E2E e exemplos

- `make up` sobe infra → one-shots (`garage-init`, `video-api-migrate`, `notification-migrate`: mesma imagem do app com `node dist/migrate.js`, só variáveis `DB_*`) → apps; os apps esperam os one-shots com `service_completed_successfully`. `make up WORKERS=n` ou `docker compose up -d --scale video-worker=n` escala o worker; cada réplica tem `/work` próprio (tmpfs de 1 GiB, nunca volume compartilhado). `stop_grace_period` do worker: 720 s (seção 9). O RabbitMQ sobe com `infra/rabbitmq/enabled_plugins` (shovel para o redrive das DLQs).
- BDD: `tests/bdd/features/*.feature` (pt-BR, jest-cucumber), `npm run test:bdd` contra o stack no ar; `make test-bdd` sobe o stack com 3 workers, `ZIP_RETENTION_DAYS=0.0005` e `DATA_RETENTION_INTERVAL_S=10`. O CI roda o mesmo no job `e2e-bdd`, com as imagens do build.
- Exemplos versionados em `examples/` (`sample-ok-5s.mp4`, `sample-ok-10s.mp4`, `sample-corrupt.mp4`, gerados por `tests/fixtures/generate.sh --examples`); passo a passo em `docs/exemplos.md` e `docs/exemplos.http`; roteiros `scripts/demo/happy-path.sh` e `sad-path.sh`; pico com k6 em `tests/load/spike.js`.
