import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * LGPD, propagation of the erasure (contratos.md, sections 6 and 12):
 * - `deleted_users`: ids of users whose `user.deleted` was applied, written in the SAME
 *   transaction as the anonymization. A `video.failed`/`video.completed` of that user consumed
 *   later (race with prefetch 5, a retry or a DLQ redrive) is not registered: the address and
 *   the name are never stored again and no e-mail goes out. Only UUIDs (no personal data);
 *   rows older than `NOTIFICATION_RETENTION_DAYS` are purged by the daily job;
 * - `ix_notifications_created`: the e-mail budget counts the last 24 h and the retention job
 *   filters by `created_at`.
 */
export class DeletedUsers1790640000000 implements MigrationInterface {
  name = 'DeletedUsers1790640000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE deleted_users (
  user_id uuid PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
)`);
    await queryRunner.query('CREATE INDEX ix_notifications_created ON notifications (created_at)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS ix_notifications_created');
    await queryRunner.query('DROP TABLE IF EXISTS deleted_users');
  }
}
