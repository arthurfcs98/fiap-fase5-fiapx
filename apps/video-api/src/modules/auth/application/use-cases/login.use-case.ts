import { AuthErrors } from '@fiapx/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AccessToken, AccessTokenIssuer } from '../../domain/access-token.port';
import { ACCESS_TOKEN_ISSUER } from '../../domain/access-token.port';
import type { PasswordHasher } from '../../domain/password-hasher.port';
import { PASSWORD_HASHER } from '../../domain/password-hasher.port';
import type { UserRepository } from '../../domain/user.repository';
import { USER_REPOSITORY } from '../../domain/user.repository';

export interface LoginInput {
  email: string;
  password: string;
}

/** `POST /api/auth/login`: generic `401 A0001` for unknown e-mail or wrong password. */
@Injectable()
export class LoginUseCase {
  private readonly logger = new Logger(LoginUseCase.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(ACCESS_TOKEN_ISSUER) private readonly tokens: AccessTokenIssuer,
  ) {}

  async execute(input: LoginInput): Promise<AccessToken> {
    const user = await this.users.findByEmail(input.email);
    // Unknown e-mail: compare against a hash of a random secret, so both paths cost one bcrypt.
    const passwordHash = user?.passwordHash ?? (await this.hasher.timingEqualizerHash());
    const valid = await this.hasher.verify(input.password, passwordHash);
    if (!user || !valid) {
      this.logger.warn({ msg: 'Login recusado', userId: user?.id });
      throw AuthErrors.INVALID_CREDENTIALS();
    }
    this.logger.log({ msg: 'Login efetuado', userId: user.id });
    return this.tokens.issue(user.id);
  }
}
