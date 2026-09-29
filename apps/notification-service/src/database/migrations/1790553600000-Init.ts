import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `fiapx_notification` schema: contratos.md section 6, plus `user_id` + `ix_notifications_user`
 * from section 12 (LGPD: anonymization on `user.deleted`), in the initial migration because the
 * table was never deployed without them.
 */
export class Init1790553600000 implements MigrationInterface {
  name = 'Init1790553600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  dedup_key varchar(200) NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  type varchar(40) NOT NULL,
  recipient varchar(255) NOT NULL,
  subject varchar(255) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'PENDING',
  attempts int NOT NULL DEFAULT 0,
  provider_message_id varchar(100),
  last_error varchar(500),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
)`);
    await queryRunner.query('CREATE INDEX ix_notifications_user ON notifications (user_id)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE notifications');
  }
}
