import type { QueryRunner } from 'typeorm';
import { StatusHistoryIndex1790640000000 } from './1790640000000-status-history-index';

describe('StatusHistoryIndex1790640000000 (contratos.md, section 5)', () => {
  it('creates and drops ix_video_status_history_video idempotently', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const runner = { query } as unknown as QueryRunner;
    const migration = new StatusHistoryIndex1790640000000();

    await migration.up(runner);
    await migration.down(runner);

    expect(migration.name).toBe('StatusHistoryIndex1790640000000');
    expect(query.mock.calls).toEqual([
      [
        'CREATE INDEX IF NOT EXISTS ix_video_status_history_video ON video_status_history (video_id)',
      ],
      ['DROP INDEX IF EXISTS ix_video_status_history_video'],
    ]);
  });
});
