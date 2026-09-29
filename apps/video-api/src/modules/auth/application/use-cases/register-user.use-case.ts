import { randomUUID } from 'node:crypto';
import { AuthErrors } from '@fiapx/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Clock } from '../../../../shared/domain/clock';
import { CLOCK } from '../../../../shared/domain/clock';
import type { PasswordHasher } from '../../domain/password-hasher.port';
import { PASSWORD_HASHER } from '../../domain/password-hasher.port';
import type { User, UserView } from '../../domain/user';
import { toUserView } from '../../domain/user';
import type { UserRepository } from '../../domain/user.repository';
import { EmailAlreadyRegisteredError, USER_REPOSITORY } from '../../domain/user.repository';
import type { AuthSettings } from '../auth.settings';
import { AUTH_SETTINGS } from '../auth.settings';

export interface RegisterUserInput {
  name: string;
  email: string;
  password: string;
  /** Already validated as `true` by the HTTP layer (no consent → 400 X0001). */
  acceptPrivacyPolicy: true;
}

/**
 * `POST /api/auth/register` (contratos.md, sections 8 and 12): stores the bcrypt hash and the
 * privacy policy consent (`privacy_accepted_at`, `privacy_policy_version`).
 */
@Injectable()
export class RegisterUserUseCase {
  private readonly logger = new Logger(RegisterUserUseCase.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings,
  ) {}

  async execute(input: RegisterUserInput): Promise<UserView> {
    if (await this.users.findByEmail(input.email)) throw AuthErrors.EMAIL_ALREADY_REGISTERED();

    const now = this.clock.now();
    const user: User = {
      id: randomUUID(),
      name: input.name,
      email: input.email,
      passwordHash: await this.hasher.hash(input.password),
      privacyAcceptedAt: now,
      privacyPolicyVersion: this.settings.privacyPolicyVersion,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.users.insert(user);
    } catch (error) {
      if (error instanceof EmailAlreadyRegisteredError) throw AuthErrors.EMAIL_ALREADY_REGISTERED();
      throw error;
    }

    this.logger.log({
      msg: 'Usuário cadastrado',
      userId: user.id,
      privacyPolicyVersion: user.privacyPolicyVersion,
    });
    return toUserView(user);
  }
}
