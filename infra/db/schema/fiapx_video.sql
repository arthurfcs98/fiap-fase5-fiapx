-- =============================================================================
-- FIAP Frames: script de criação do banco `fiapx_video` (dono: video-api)
--
-- Versão LEGÍVEL e equivalente das migrações oficiais, na ordem de
-- apps/video-api/src/database/migrations/index.ts:
--   1790553600000-init.ts                 (Init1790553600000)
--   1790640000000-status-history-index.ts (StatusHistoryIndex1790640000000)
-- conferida com `pg_dump --schema-only` (PostgreSQL 16): o schema criado por este arquivo é
-- idêntico ao criado pelas migrações, inclusive os nomes das constraints e a tabela
-- `migrations` do TypeORM (infra/db/README.md, "Como foi conferido").
--
-- Caminho oficial (compose e Kubernetes): o one-shot `node dist/migrate.js` da imagem do
-- video-api (serviço `video-api-migrate` no compose, Job `video-api-migrate` no K3s). Este
-- arquivo serve para ler o modelo e, se preciso, criar o schema à mão.
--
-- Pré-requisito: banco e role criados por infra/postgres/init/00-create-databases.sh.
-- Uso (como o DONO do banco, para os objetos ficarem com o mesmo dono da migração):
--   psql -v ON_ERROR_STOP=1 -h <host> -U fiapx_video -d fiapx_video -f infra/db/schema/fiapx_video.sql
-- Tudo numa transação: cria tudo ou nada. Não é idempotente (a 2ª execução falha no
-- CREATE TYPE e nada muda); para reaplicar, use o one-shot de migração.
--
-- Nomes, tipos e regras: docs/arquitetura/contratos.md, seções 3, 5 e 12.
-- =============================================================================

BEGIN;

-- E-mail sem diferença entre maiúsculas e minúsculas (o UNIQUE de users.email usa citext).
CREATE EXTENSION IF NOT EXISTS citext;

-- Estados do vídeo (máquina de estados, contratos.md seção 3; dona: video-api).
CREATE TYPE video_status AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- -----------------------------------------------------------------------------
-- users: contas (cadastro e login com JWT).
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id                     uuid         PRIMARY KEY,            -- gerado pela aplicação (UUID v4)
  name                   varchar(120) NOT NULL,
  email                  citext       NOT NULL UNIQUE,        -- constraint users_email_key
  password_hash          varchar(100) NOT NULL,               -- bcrypt custo 12; a senha nunca é gravada
  privacy_accepted_at    timestamptz  NOT NULL,               -- LGPD: prova do aceite da política
  privacy_policy_version varchar(20)  NOT NULL,               -- LGPD: versão aceita (PRIVACY_POLICY_VERSION)
  created_at             timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- videos: um upload = uma linha; o status é a máquina de estados.
-- As chaves do storage só têm UUIDs: raw `{userId}/{videoId}{ext}`, zip `{userId}/{videoId}.zip`
-- (o nome enviado pelo usuário nunca vira caminho).
-- -----------------------------------------------------------------------------
CREATE TABLE videos (
  id              uuid         PRIMARY KEY,
  user_id         uuid         NOT NULL REFERENCES users(id),  -- dono (toda consulta filtra por ele)
  original_name   varchar(255) NOT NULL,                       -- só para exibir e para o nome do download
  size_bytes      bigint       NOT NULL,
  content_type    varchar(100),                                -- detectado pelos magic bytes
  raw_key         varchar(300) NOT NULL,                       -- objeto no bucket fiapx-raw
  zip_key         varchar(300),                                -- objeto no bucket fiapx-zips (NULL depois da retenção)
  status          video_status NOT NULL DEFAULT 'QUEUED',
  attempts        int          NOT NULL DEFAULT 0,             -- tentativas do worker (evento started)
  frame_count     int,
  zip_size_bytes  bigint,
  error_code      varchar(10),                                 -- P0001..P0099 (contratos.md, seção 4)
  error_message   varchar(500),                                -- texto amigável; o detalhe técnico fica no log
  idempotency_key varchar(100),                                -- header Idempotency-Key do upload
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  started_at      timestamptz,
  completed_at    timestamptz,                                 -- COMPLETED ou FAILED
  expired_at      timestamptz,                                 -- LGPD: zip apagado pela retenção (download → 410 V0006)
  UNIQUE (user_id, idempotency_key)                            -- reenvio com a mesma chave devolve o mesmo vídeo
);

-- Listagem do usuário, mais recentes primeiro (GET /api/videos).
CREATE INDEX ix_videos_user_created ON videos (user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- video_status_history: trilha de cada transição (GET /api/videos/:id → history).
-- Gravada na MESMA transação que muda videos.status.
-- -----------------------------------------------------------------------------
CREATE TABLE video_status_history (
  id          bigserial    PRIMARY KEY,
  video_id    uuid         NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  from_status video_status,                                    -- NULL na criação (→ QUEUED)
  to_status   video_status NOT NULL,
  reason      varchar(200),
  created_at  timestamptz  NOT NULL DEFAULT now()
);

-- Histórico de um vídeo (detalhe e exportação LGPD leem por video_id). Migração 1790640000000.
CREATE INDEX ix_video_status_history_video ON video_status_history (video_id);

-- -----------------------------------------------------------------------------
-- outbox_events: Transactional Outbox. O evento é gravado na mesma transação do dado
-- (upload, COMPLETED/FAILED, eliminação de conta) e um relay publica no RabbitMQ a cada 500 ms
-- (SELECT ... FOR UPDATE SKIP LOCKED, lotes de 50, lease em locked_until, publisher confirm).
-- -----------------------------------------------------------------------------
CREATE TABLE outbox_events (
  id             uuid         PRIMARY KEY,                     -- = id do envelope = AMQP messageId
  aggregate_id   uuid         NOT NULL,                        -- videoId ou userId
  event_type     varchar(100) NOT NULL,                        -- routing key (ex.: video.uploaded)
  payload        jsonb        NOT NULL,
  correlation_id varchar(100) NOT NULL,                        -- = CORRELATION_ID_MAX_LENGTH
  created_at     timestamptz  NOT NULL DEFAULT now(),
  published_at   timestamptz,                                  -- NULL = pendente
  attempts       int          NOT NULL DEFAULT 0,
  last_error     varchar(500),
  locked_until   timestamptz                                   -- lease: várias réplicas sem publicar em dobro
);

-- Só as linhas pendentes entram no índice (o relay consulta por ordem de criação).
CREATE INDEX ix_outbox_pending ON outbox_events (created_at) WHERE published_at IS NULL;

-- -----------------------------------------------------------------------------
-- processed_messages: inbox dos consumidores do video-api (idempotência). A mesma mensagem
-- entregue de novo (at-least-once) encontra a linha e não muda nada.
-- -----------------------------------------------------------------------------
CREATE TABLE processed_messages (
  message_id   uuid         NOT NULL,                          -- AMQP messageId (= id do evento)
  consumer     varchar(100) NOT NULL,                          -- fila do consumidor (ex.: api.video-processing)
  processed_at timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, consumer)
);

-- -----------------------------------------------------------------------------
-- migrations: controle do TypeORM (criado automaticamente pelo one-shot de migração).
-- Registrar aqui as migrações equivalentes a este arquivo faz o `node dist/migrate.js` rodado
-- depois dele responder "Nenhuma migração pendente" em vez de tentar criar tudo de novo.
-- -----------------------------------------------------------------------------
CREATE TABLE migrations (
  id          serial            NOT NULL,
  "timestamp" bigint            NOT NULL,
  name        character varying NOT NULL,
  CONSTRAINT "PK_8c82d7f526340ab734260ea46be" PRIMARY KEY (id)
);
INSERT INTO migrations ("timestamp", name) VALUES
  (1790553600000, 'Init1790553600000'),
  (1790640000000, 'StatusHistoryIndex1790640000000');

COMMIT;
