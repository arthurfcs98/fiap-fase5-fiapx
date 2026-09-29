import type { QueryRunner } from 'typeorm';
import { DOWN_STATEMENTS, Init1790553600000, UP_STATEMENTS } from './1790553600000-init';
import { StatusHistoryIndex1790640000000 } from './1790640000000-status-history-index';
import { MIGRATIONS } from './index';

function recordingRunner(): { runner: QueryRunner; statements: string[] } {
  const statements: string[] = [];
  const runner = {
    query: jest.fn((sql: string) => {
      statements.push(sql);
      return Promise.resolve();
    }),
  } as unknown as QueryRunner;
  return { runner, statements };
}

const normalize = (sql: string) => sql.replace(/\s+/g, ' ');

describe('Init1790553600000 (contratos.md, sections 5 and 12)', () => {
  it('is the first migration and every migration is listed explicitly (no glob)', () => {
    expect(MIGRATIONS).toEqual([Init1790553600000, StatusHistoryIndex1790640000000]);
    expect(new Init1790553600000().name).toBe('Init1790553600000');
  });

  it('up creates the contract tables, enum, indexes and the LGPD columns in order', async () => {
    const { runner, statements } = recordingRunner();

    await new Init1790553600000().up(runner);

    expect(statements).toEqual(UP_STATEMENTS);
    const sql = statements.map(normalize).join('\n');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS citext');
    expect(sql).toContain(
      "CREATE TYPE video_status AS ENUM ('QUEUED','PROCESSING','COMPLETED','FAILED')",
    );
    for (const table of [
      'users',
      'videos',
      'video_status_history',
      'outbox_events',
      'processed_messages',
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table} (`);
    }
    expect(sql).toContain('email citext NOT NULL UNIQUE');
    expect(sql).toContain('privacy_accepted_at timestamptz NOT NULL');
    expect(sql).toContain('privacy_policy_version varchar(20) NOT NULL');
    expect(sql).toContain('expired_at timestamptz');
    expect(sql).toContain('UNIQUE (user_id, idempotency_key)');
    expect(sql).toContain('correlation_id varchar(100) NOT NULL');
    expect(sql).toContain(
      'CREATE INDEX ix_outbox_pending ON outbox_events (created_at) WHERE published_at IS NULL',
    );
    expect(sql).toContain(
      'CREATE INDEX ix_videos_user_created ON videos (user_id, created_at DESC)',
    );
    expect(sql).toContain('PRIMARY KEY (message_id, consumer)');
  });

  it('down drops everything in reverse dependency order', async () => {
    const { runner, statements } = recordingRunner();

    await new Init1790553600000().down(runner);

    expect(statements).toEqual(DOWN_STATEMENTS);
    expect(statements.at(-1)).toBe('DROP TYPE IF EXISTS video_status');
  });
});
