import { readdirSync } from 'node:fs';
import type { QueryRunner } from 'typeorm';
import { Init1790553600000 } from './1790553600000-Init';
import { DeletedUsers1790640000000 } from './1790640000000-DeletedUsers';
import { NOTIFICATION_MIGRATIONS } from '.';

function recordingRunner(): { runner: QueryRunner; sql: string[] } {
  const sql: string[] = [];
  const runner = {
    query: (statement: string) => {
      sql.push(statement.replace(/\s+/g, ' ').trim());
      return Promise.resolve(undefined);
    },
  } as unknown as QueryRunner;
  return { runner, sql };
}

describe('fiapx_notification migrations', () => {
  it('registers every migration file of the folder, in timestamp order (no glob)', () => {
    const files = readdirSync(__dirname)
      .filter((file) => /^\d+-.+\.ts$/.test(file) && !file.endsWith('.spec.ts'))
      .sort();
    const registered = NOTIFICATION_MIGRATIONS.map((migration) => new migration().name);

    expect(registered).toEqual(
      files.map((file) => {
        const [timestamp, rest] = file.replace(/\.ts$/, '').split('-') as [string, string];
        return `${rest}${timestamp}`;
      }),
    );
  });

  it('Init creates exactly the table of contratos.md sections 6 and 12', async () => {
    const { runner, sql } = recordingRunner();

    await new Init1790553600000().up(runner);

    expect(sql).toEqual([
      'CREATE TABLE notifications ( ' +
        'id uuid PRIMARY KEY, ' +
        'dedup_key varchar(200) NOT NULL UNIQUE, ' +
        'user_id uuid NOT NULL, ' +
        'type varchar(40) NOT NULL, ' +
        'recipient varchar(255) NOT NULL, ' +
        'subject varchar(255) NOT NULL, ' +
        "status varchar(20) NOT NULL DEFAULT 'PENDING', " +
        'attempts int NOT NULL DEFAULT 0, ' +
        'provider_message_id varchar(100), ' +
        'last_error varchar(500), ' +
        'payload jsonb NOT NULL, ' +
        'created_at timestamptz NOT NULL DEFAULT now(), ' +
        'sent_at timestamptz )',
      'CREATE INDEX ix_notifications_user ON notifications (user_id)',
    ]);
  });

  it('Init can be reverted', async () => {
    const { runner, sql } = recordingRunner();

    await new Init1790553600000().down(runner);

    expect(sql).toEqual(['DROP TABLE notifications']);
  });

  it('DeletedUsers creates deleted_users and the created_at index (and drops them)', async () => {
    const { runner, sql } = recordingRunner();
    const migration = new DeletedUsers1790640000000();

    await migration.up(runner);
    await migration.down(runner);

    expect(sql).toEqual([
      'CREATE TABLE deleted_users ( user_id uuid PRIMARY KEY, deleted_at timestamptz NOT NULL DEFAULT now() )',
      'CREATE INDEX ix_notifications_created ON notifications (created_at)',
      'DROP INDEX IF EXISTS ix_notifications_created',
      'DROP TABLE IF EXISTS deleted_users',
    ]);
  });
});
