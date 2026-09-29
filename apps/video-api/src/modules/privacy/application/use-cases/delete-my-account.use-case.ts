import { AuthErrors } from '@fiapx/common';
import { createEvent } from '@fiapx/contracts';
import type { StorageBuckets } from '@fiapx/storage';
import { STORAGE_BUCKETS } from '@fiapx/storage';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work';
import { UNIT_OF_WORK } from '../../../../shared/application/unit-of-work';
import type { PasswordHasher } from '../../../auth/domain/password-hasher.port';
import { PASSWORD_HASHER } from '../../../auth/domain/password-hasher.port';
import type { UserRepository } from '../../../auth/domain/user.repository';
import { USER_REPOSITORY } from '../../../auth/domain/user.repository';
import type { UserObjectStore } from '../../domain/user-object.store';
import { USER_OBJECT_STORE } from '../../domain/user-object.store';

export interface DeleteMyAccountInput {
  userId: string;
  password: string;
  correlationId: string;
}

export interface AccountDeletion {
  deletedVideos: number;
  deletedObjects: number;
  /** Some objects could not be deleted now; the hourly orphan sweep removes them. */
  objectsPending: boolean;
}

/**
 * `DELETE /api/me` — erasure (LGPD art. 18 VI, contratos.md section 12):
 * 1. password confirmation (wrong → `400 A0004`, the session stays valid);
 * 2. ONE transaction: history, videos and user are deleted, the user's outbox rows (payloads
 *    with e-mail/name) are dropped and `user.deleted { userId }` is written to the outbox — the
 *    notification-service anonymizes its notifications when it arrives;
 * 3. after the commit, every object under `{userId}/` in both buckets is deleted.
 * Tokens issued before stop working because the JWT strategy checks that the user exists.
 */
@Injectable()
export class DeleteMyAccountUseCase {
  private readonly logger = new Logger(DeleteMyAccountUseCase.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(USER_OBJECT_STORE) private readonly objects: UserObjectStore,
    @Inject(STORAGE_BUCKETS) private readonly buckets: StorageBuckets,
  ) {}

  async execute(input: DeleteMyAccountInput): Promise<AccountDeletion> {
    const user = await this.users.findById(input.userId);
    if (!user) throw AuthErrors.UNAUTHORIZED();
    if (!(await this.hasher.verify(input.password, user.passwordHash))) {
      this.logger.warn({ msg: 'Confirmação de senha incorreta na eliminação', userId: user.id });
      throw AuthErrors.INVALID_PASSWORD_CONFIRMATION();
    }

    const deletedVideoIds = await this.uow.run(async (tx) => {
      if (!(await tx.users.lockById(user.id))) throw AuthErrors.UNAUTHORIZED();
      const videoIds = await tx.videos.deleteAllByOwner(user.id);
      await tx.outbox.deleteByAggregateIds([...videoIds, user.id]);
      await tx.users.deleteById(user.id);
      await tx.outbox.add(
        createEvent('user.deleted', { userId: user.id }, input.correlationId),
        user.id,
      );
      return videoIds;
    });

    const { deleted, pending } = await this.deleteObjects(user.id);
    this.logger.log({
      msg: 'Conta eliminada (LGPD)',
      userId: user.id,
      deletedVideos: deletedVideoIds.length,
      deletedObjects: deleted,
      objectsPending: pending,
    });
    return {
      deletedVideos: deletedVideoIds.length,
      deletedObjects: deleted,
      objectsPending: pending,
    };
  }

  private async deleteObjects(userId: string): Promise<{ deleted: number; pending: boolean }> {
    let deleted = 0;
    let pending = false;
    for (const bucket of [this.buckets.raw, this.buckets.zips]) {
      try {
        deleted += await this.objects.deleteAllOf(bucket, userId);
      } catch (error) {
        pending = true;
        this.logger.error({
          msg: 'Falha ao apagar objetos do usuário eliminado (a varredura horária tenta de novo)',
          userId,
          bucket,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { deleted, pending };
  }
}
