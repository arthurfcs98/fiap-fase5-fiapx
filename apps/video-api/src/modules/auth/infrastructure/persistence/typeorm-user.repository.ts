import type { EntityManager } from 'typeorm';
import { In } from 'typeorm';
import {
  isPgError,
  PG_UNIQUE_VIOLATION,
} from '../../../../shared/infrastructure/database/pg-errors';
import type { User } from '../../domain/user';
import type { UserRepository } from '../../domain/user.repository';
import { EmailAlreadyRegisteredError } from '../../domain/user.repository';
import { UserOrmEntity } from './user.orm-entity';

/** Name Postgres gives to the `email citext NOT NULL UNIQUE` constraint. */
export const USERS_EMAIL_CONSTRAINT = 'users_email_key';

/**
 * TypeORM adapter of {@link UserRepository}. Built on an `EntityManager`: the default one for
 * reads, the transaction's one inside the unit of work.
 */
export class TypeOrmUserRepository implements UserRepository {
  constructor(private readonly manager: EntityManager) {}

  private get repository() {
    return this.manager.getRepository(UserOrmEntity);
  }

  async findById(id: string): Promise<User | null> {
    return toDomain(await this.repository.findOne({ where: { id } }));
  }

  async findByEmail(email: string): Promise<User | null> {
    return toDomain(await this.repository.findOne({ where: { email } }));
  }

  async insert(user: User): Promise<void> {
    try {
      await this.repository.insert(toOrm(user));
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION, USERS_EMAIL_CONSTRAINT)) {
        throw new EmailAlreadyRegisteredError();
      }
      throw error;
    }
  }

  async lockById(id: string): Promise<User | null> {
    return toDomain(
      await this.repository.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } }),
    );
  }

  async deleteById(id: string): Promise<void> {
    await this.repository.delete({ id });
  }

  async existingIds(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.repository.find({ select: { id: true }, where: { id: In([...ids]) } });
    return new Set(rows.map((row) => row.id));
  }
}

function toDomain(entity: UserOrmEntity | null): User | null {
  if (!entity) return null;
  return {
    id: entity.id,
    name: entity.name,
    email: entity.email,
    passwordHash: entity.passwordHash,
    privacyAcceptedAt: entity.privacyAcceptedAt,
    privacyPolicyVersion: entity.privacyPolicyVersion,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}

function toOrm(user: User): UserOrmEntity {
  return Object.assign(new UserOrmEntity(), user);
}
