import { randomBytes } from 'node:crypto';
import type { OnModuleInit } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';
import type { PasswordHasher } from '../../domain/password-hasher.port';
import { BCRYPT_COST } from '../../auth.constants';

/** bcrypt adapter (pure JS `bcryptjs`: no native build in the Alpine image). */
export class BcryptPasswordHasher implements PasswordHasher, OnModuleInit {
  private equalizer?: Promise<string>;

  constructor(private readonly cost: number = BCRYPT_COST) {}

  /** Computes the timing equalizer at boot, so even the first login pays no extra hash. */
  async onModuleInit(): Promise<void> {
    await this.timingEqualizerHash();
  }

  hash(plain: string): Promise<string> {
    return hash(plain, this.cost);
  }

  verify(plain: string, passwordHash: string): Promise<boolean> {
    return compare(plain, passwordHash);
  }

  timingEqualizerHash(): Promise<string> {
    // Once per process, from 32 random bytes that are discarded: there is no fixed hash in the code.
    this.equalizer ??= hash(randomBytes(32).toString('hex'), this.cost);
    return this.equalizer;
  }
}
