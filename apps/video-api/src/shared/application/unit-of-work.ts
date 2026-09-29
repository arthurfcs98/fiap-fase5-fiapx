import type { UserRepository } from '../../modules/auth/domain/user.repository';
import type { OutboxWriter } from '../../modules/outbox/domain/outbox.ports';
import type { VideoRepository } from '../../modules/videos/domain/video.repository';
import type { ProcessedMessages } from './processed-messages';

/** Repositories bound to ONE database transaction. */
export interface TransactionScope {
  users: UserRepository;
  videos: VideoRepository;
  outbox: OutboxWriter;
  processedMessages: ProcessedMessages;
  /**
   * `pg_try_advisory_xact_lock(hashtext(name))`: `false` when another transaction (another
   * replica) holds it. Released automatically at commit/rollback.
   */
  tryAdvisoryLock(name: string): Promise<boolean>;
}

/**
 * Runs `work` in a transaction: everything commits together (e.g. video + history + outbox) or
 * nothing does. Rejections roll back and propagate.
 */
export interface UnitOfWork {
  run<T>(work: (tx: TransactionScope) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
