import type { JwtService } from '@nestjs/jwt';
import type { AccessToken, AccessTokenIssuer } from '../../domain/access-token.port';
import { JWT_ALGORITHM, JWT_AUDIENCE, JWT_ISSUER } from '../../auth.constants';

export interface JwtIssuerOptions {
  secret: string;
  /** Seconds. */
  expiresIn: number;
}

/** Access token = JWT HS256 with `sub` (user id), `iss`, `aud` and `exp`; nothing personal. */
export class JwtAccessTokenIssuer implements AccessTokenIssuer {
  constructor(
    private readonly jwt: JwtService,
    private readonly options: JwtIssuerOptions,
  ) {}

  async issue(userId: string): Promise<AccessToken> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId },
      {
        secret: this.options.secret,
        algorithm: JWT_ALGORITHM,
        expiresIn: this.options.expiresIn,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      },
    );
    return { accessToken, tokenType: 'Bearer', expiresIn: this.options.expiresIn };
  }
}
