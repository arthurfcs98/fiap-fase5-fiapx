import type { DataSource, EntityManager } from 'typeorm';
import { TypeOrmUserRepository } from '../../../modules/auth/infrastructure/persistence/typeorm-user.repository';
import { TypeOrmOutboxWriter } from '../../../modules/outbox/infrastructure/typeorm-outbox.writer';
import { TypeOrmVideoRepository } from '../../../modules/videos/infrastructure/persistence/typeorm-video.repository';
import type { TransactionScope, UnitOfWork } from '../../application/unit-of-work';
import { TypeOrmProcessedMessages } from './typeorm-processed-messages';

/** {@link UnitOfWork} on `DataSource.transaction` (READ COMMITTED, rollback on rejection). */
export class TypeOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly dataSource: DataSource) {}

  run<T>(work: (tx: TransactionScope) => Promise<T>): Promise<T> {
    return this.dataSource.transaction((manager) => work(transactionScope(manager)));
  }
}

/** Repositories bound to `manager` (the transaction's entity manager). */
export function transactionScope(manager: EntityManager): TransactionScope {
  return {
    users: new TypeOrmUserRepository(manager),
    videos: new TypeOrmVideoRepository(manager),
    outbox: new TypeOrmOutboxWriter(manager),
    processedMessages: new TypeOrmProcessedMessages(manager),
    tryAdvisoryLock: async (name: string) => {
      const rows = await manager.query<{ locked: boolean }[]>(
        `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`,
        [name],
      );
      return rows[0]?.locked === true;
    },
  };
}
