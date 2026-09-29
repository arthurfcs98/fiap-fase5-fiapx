-- =============================================================================
-- FIAP Frames: script de criação do banco `fiapx_notification` (dono: notification-service)
--
-- Versão LEGÍVEL e equivalente das migrações oficiais, na ordem de
-- apps/notification-service/src/database/migrations/index.ts:
--   1790553600000-Init.ts          (Init1790553600000)
--   1790640000000-DeletedUsers.ts  (DeletedUsers1790640000000)
-- conferida com `pg_dump --schema-only` (PostgreSQL 16): o schema criado por este arquivo é
-- idêntico ao criado pelas migrações, inclusive os nomes das constraints e a tabela
-- `migrations` do TypeORM (infra/db/README.md, "Como foi conferido").
--
-- Caminho oficial (compose e Kubernetes): o one-shot `node dist/migrate.js` da imagem do
-- notification-service (serviço `notification-migrate` no compose, Job `notification-migrate`
-- no K3s). Este arquivo serve para ler o modelo e, se preciso, criar o schema à mão.
--
-- Pré-requisito: banco e role criados por infra/postgres/init/00-create-databases.sh.
-- Uso (como o DONO do banco):
--   psql -v ON_ERROR_STOP=1 -h <host> -U fiapx_notification -d fiapx_notification \
--     -f infra/db/schema/fiapx_notification.sql
-- Tudo numa transação: cria tudo ou nada. Não é idempotente (a 2ª execução falha no
-- CREATE TABLE e nada muda); para reaplicar, use o one-shot de migração.
--
-- Banco separado do fiapx_video (database per service): o notification-service não lê as
-- tabelas do video-api; tudo o que ele precisa chega no payload dos eventos.
-- Nomes e regras: docs/arquitetura/contratos.md, seções 6 e 12.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- notifications: um e-mail por evento de negócio. A dedup_key única torna o consumo
-- idempotente: o mesmo evento entregue de novo encontra a linha (SENT → não reenvia).
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
  id                  uuid         PRIMARY KEY,                -- também é a Idempotency-Key enviada ao Resend
  dedup_key           varchar(200) NOT NULL UNIQUE,            -- ex.: VIDEO_FAILED:<videoId>
  user_id             uuid         NOT NULL,                   -- LGPD: anonimização no evento user.deleted
  type                varchar(40)  NOT NULL,                   -- VIDEO_FAILED | VIDEO_COMPLETED
  recipient           varchar(255) NOT NULL,                   -- e-mail; vira 'removido' na retenção/eliminação
  subject             varchar(255) NOT NULL,
  status              varchar(20)  NOT NULL DEFAULT 'PENDING', -- PENDING | SENT | FAILED
  attempts            int          NOT NULL DEFAULT 0,
  provider_message_id varchar(100),                            -- id devolvido pelo provedor (Resend/SMTP)
  last_error          varchar(500),
  payload             jsonb        NOT NULL,                   -- dados do template; vira '{}' na retenção
  created_at          timestamptz  NOT NULL DEFAULT now(),
  sent_at             timestamptz
);

-- Anonimização por usuário (evento user.deleted, contratos.md seção 12).
CREATE INDEX ix_notifications_user ON notifications (user_id);

-- -----------------------------------------------------------------------------
-- deleted_users (migração 1790640000000): ids dos usuários cujo user.deleted já foi aplicado,
-- gravados na mesma transação da anonimização. Um video.failed/video.completed desse usuário
-- que chegue depois (retry, redrive de DLQ) não volta a gravar e-mail nem nome, e nenhum e-mail
-- sai. Só UUIDs, nenhum dado pessoal.
-- -----------------------------------------------------------------------------
CREATE TABLE deleted_users (
  user_id    uuid        PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

-- Consultas por período (janela de 24 h do envio e o job diário de retenção).
CREATE INDEX ix_notifications_created ON notifications (created_at);

-- -----------------------------------------------------------------------------
-- migrations: controle do TypeORM (criado automaticamente pelo one-shot de migração).
-- Registrar aqui as migrações equivalentes a este arquivo faz o `node dist/migrate.js` rodado
-- depois dele responder "Nenhuma migração pendente".
-- -----------------------------------------------------------------------------
CREATE TABLE migrations (
  id          serial            NOT NULL,
  "timestamp" bigint            NOT NULL,
  name        character varying NOT NULL,
  CONSTRAINT "PK_8c82d7f526340ab734260ea46be" PRIMARY KEY (id)
);
INSERT INTO migrations ("timestamp", name) VALUES
  (1790553600000, 'Init1790553600000'),
  (1790640000000, 'DeletedUsers1790640000000');

COMMIT;
