import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `ix_video_status_history_video` (contratos.md, section 5): the detail and the export read the
 * history by `video_id`, and without an index every read scanned the whole table (19,642 rows
 * read to return 3 in the review). Plain `CREATE INDEX IF NOT EXISTS`: the table is small at
 * deploy time and the migration runs as a one-shot before the new pods.
 */
export class StatusHistoryIndex1790640000000 implements MigrationInterface {
  name = 'StatusHistoryIndex1790640000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ix_video_status_history_video ON video_status_history (video_id)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS ix_video_status_history_video`);
  }
}
