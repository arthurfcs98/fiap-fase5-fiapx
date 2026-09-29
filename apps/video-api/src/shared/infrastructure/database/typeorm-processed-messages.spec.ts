import type { EntityManager } from 'typeorm';
import { TypeOrmProcessedMessages } from './typeorm-processed-messages';

describe('TypeOrmProcessedMessages', () => {
  it('INSERT ... ON CONFLICT DO NOTHING: true only the first time', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ message_id: 'm' }])
      .mockResolvedValueOnce([]);
    const inbox = new TypeOrmProcessedMessages({ query } as unknown as EntityManager);

    await expect(inbox.markProcessed('m', 'api.video-processing')).resolves.toBe(true);
    await expect(inbox.markProcessed('m', 'api.video-processing')).resolves.toBe(false);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT DO NOTHING RETURNING message_id');
    expect(params).toEqual(['m', 'api.video-processing']);
  });

  it('purges old rows', async () => {
    const query = jest.fn().mockResolvedValue([[], 5]);
    const cutoff = new Date(0);
    await expect(
      new TypeOrmProcessedMessages({ query } as unknown as EntityManager).purgeBefore(cutoff),
    ).resolves.toBe(5);
    expect(query).toHaveBeenCalledWith('DELETE FROM processed_messages WHERE processed_at < $1', [
      cutoff,
    ]);
  });
});
