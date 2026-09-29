import type { User } from './user';

/** Persistence port of the `users` table. */
export interface UserRepository {
  findById(id: string): Promise<User | null>;
  /** Case-insensitive (`citext`). */
  findByEmail(email: string): Promise<User | null>;
  /** @throws EmailAlreadyRegisteredError when the e-mail is taken (race with another sign-up). */
  insert(user: User): Promise<void>;
  /** `SELECT ... FOR UPDATE` (only inside a transaction). */
  lockById(id: string): Promise<User | null>;
  deleteById(id: string): Promise<void>;
  /** Which of `ids` still exist (orphan object sweep). */
  existingIds(ids: readonly string[]): Promise<Set<string>>;
}

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super('E-mail already registered');
    this.name = 'EmailAlreadyRegisteredError';
  }
}
