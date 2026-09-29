import type { DataSource, EntityManager } from 'typeorm';
import { TypeOrmUserRepository } from '../../../modules/auth/infrastructure/persistence/typeorm-user.repository';
import { TypeOrmOutboxWriter } from '../../../modules/outbox/infrastructure/typeorm-outbox.writer';
import { TypeOrmVideoRepository } from '../../../modules/videos/infrastructure/persistence/typeorm-video.repository';
import { TypeOrmProcessedMessages } from './typeorm-processed-messages';
import { transactionScope, TypeOrmUnitOfWork } from './typeorm-unit-of-work';

describe('TypeOrmUnitOfWork', () => {
  it('runs the work inside DataSource.transaction with repositories bound to its manager', async () => {
    const manager = { query: jest.fn() } as unknown as EntityManager;
    const dataSource = {
      transaction: jest.fn((work: (m: EntityManager) => Promise<unknown>) => work(manager)),
    } as unknown as DataSource;

    const result = await new TypeOrmUnitOfWork(dataSource).run((tx) => {
      expect(tx.users).toBeInstanceOf(TypeOrmUserRepository);
      expect(tx.videos).toBeInstanceOf(TypeOrmVideoRepository);
      expect(tx.outbox).toBeInstanceOf(TypeOrmOutboxWriter);
      expect(tx.processedMessages).toBeInstanceOf(TypeOrmProcessedMessages);
      return Promise.resolve('done');
    });

    expect(result).toBe('done');
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('tryAdvisoryLock uses pg_try_advisory_xact_lock(hashtext(name))', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([{ locked: false }])
      .mockResolvedValueOnce([]);
    const scope = transactionScope({ query } as unknown as EntityManager);

    await expect(scope.tryAdvisoryLock('fiapx.lock')).resolves.toBe(true);
    await expect(scope.tryAdvisoryLock('fiapx.lock')).resolves.toBe(false);
    await expect(scope.tryAdvisoryLock('fiapx.lock')).resolves.toBe(false);
    expect(query).toHaveBeenCalledWith('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [
      'fiapx.lock',
    ]);
  });
});
