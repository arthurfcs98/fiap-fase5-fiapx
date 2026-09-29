import { compare, hash } from 'bcryptjs';
import type { PasswordHasher } from '../../domain/password-hasher.port';
import { BCRYPT_COST } from '../../auth.constants';

/** bcrypt adapter (pure JS `bcryptjs`: no native build in the Alpine image). */
export class BcryptPasswordHasher implements PasswordHasher {
  constructor(private readonly cost: number = BCRYPT_COST) {}

  hash(plain: string): Promise<string> {
    return hash(plain, this.cost);
  }

  verify(plain: string, passwordHash: string): Promise<boolean> {
    return compare(plain, passwordHash);
  }
}
