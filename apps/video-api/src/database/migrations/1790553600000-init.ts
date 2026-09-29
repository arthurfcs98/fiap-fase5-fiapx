import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial `fiapx_video` schema, exactly as docs/arquitetura/contratos.md section 5, plus the LGPD
 * columns of section 12 (`users.privacy_accepted_at`, `users.privacy_policy_version`,
 * `videos.expired_at`). Nothing is deployed yet, so they live in this first migration.
 */
export class Init1790553600000 implements MigrationInterface {
  name = 'Init1790553600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const statement of UP_STATEMENTS) {
      await queryRunner.query(statement);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const statement of DOWN_STATEMENTS) {
      await queryRunner.query(statement);
    }
  }
}

export const UP_STATEMENTS: readonly string[] = [
  `CREATE EXTENSION IF NOT EXISTS citext`,
  `CREATE TYPE video_status AS ENUM ('QUEUED','PROCESSING','COMPLETED','FAILED')`,
  `CREATE TABLE users (
    id uuid PRIMARY KEY,
    name varchar(120) NOT NULL,
    email citext NOT NULL UNIQUE,
    password_hash varchar(100) NOT NULL,
    privacy_accepted_at timestamptz NOT NULL,
    privacy_policy_version varchar(20) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE videos (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    original_name varchar(255) NOT NULL,
    size_bytes bigint NOT NULL,
    content_type varchar(100),
    raw_key varchar(300) NOT NULL,
    zip_key varchar(300),
    status video_status NOT NULL DEFAULT 'QUEUED',
    attempts int NOT NULL DEFAULT 0,
    frame_count int,
    zip_size_bytes bigint,
    error_code varchar(10),
    error_message varchar(500),
    idempotency_key varchar(100),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    expired_at timestamptz,
    UNIQUE (user_id, idempotency_key))`,
  `CREATE INDEX ix_videos_user_created ON videos (user_id, created_at DESC)`,
  `CREATE TABLE video_status_history (
    id bigserial PRIMARY KEY,
    video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    from_status video_status,
    to_status video_status NOT NULL,
    reason varchar(200),
    created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE outbox_events (
    id uuid PRIMARY KEY,
    aggregate_id uuid NOT NULL,
    event_type varchar(100) NOT NULL,
    payload jsonb NOT NULL,
    correlation_id varchar(100) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    attempts int NOT NULL DEFAULT 0,
    last_error varchar(500),
    locked_until timestamptz)`,
  `CREATE INDEX ix_outbox_pending ON outbox_events (created_at) WHERE published_at IS NULL`,
  `CREATE TABLE processed_messages (
    message_id uuid NOT NULL,
    consumer varchar(100) NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, consumer))`,
];

/** Reverse order; the `citext` extension stays (it may be shared by other schemas). */
export const DOWN_STATEMENTS: readonly string[] = [
  `DROP TABLE IF EXISTS processed_messages`,
  `DROP TABLE IF EXISTS outbox_events`,
  `DROP TABLE IF EXISTS video_status_history`,
  `DROP TABLE IF EXISTS videos`,
  `DROP TABLE IF EXISTS users`,
  `DROP TYPE IF EXISTS video_status`,
];
