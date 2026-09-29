import { AuthErrors, CommonErrors, DEPENDENCY_RETRY_AFTER_SECONDS } from '@fiapx/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { isUuid } from '../../../../shared/domain/uuid';
import type { ApiConfig } from '../../../../config/api.config';
import { API_CONFIG } from '../../../../config/api.config';
import type { AuthenticatedUser } from '../../domain/user';
import type { UserRepository } from '../../domain/user.repository';
import { USER_REPOSITORY } from '../../domain/user.repository';
import { JWT_ALGORITHM, JWT_AUDIENCE, JWT_ISSUER, JWT_STRATEGY } from '../../auth.constants';

export interface JwtPayload {
  sub?: unknown;
}

/**
 * Bearer JWT validation (HS256, `iss`, `aud`, `exp`). The user must still exist: after
 * `DELETE /api/me` every token issued before is rejected (contratos.md, section 12).
 *
 * A database failure while looking the user up is NOT an authentication failure: it answers
 * `503 X0003` (with `Retry-After`), so the frontend keeps the session instead of logging the
 * user out and cancelling the uploads in progress, and the availability SLO sees it as 5xx.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, JWT_STRATEGY) {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.JWT_SECRET,
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      ignoreExpiration: false,
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (!isUuid(payload.sub)) throw AuthErrors.UNAUTHORIZED();
    let user: Awaited<ReturnType<UserRepository['findById']>>;
    try {
      user = await this.users.findById(payload.sub);
    } catch (error) {
      this.logger.warn({
        msg: 'Banco indisponível ao validar o token: 503 (a sessão continua válida)',
        error: error instanceof Error ? error.message : String(error),
      });
      throw CommonErrors.UNAVAILABLE(DEPENDENCY_RETRY_AFTER_SECONDS);
    }
    if (!user) throw AuthErrors.UNAUTHORIZED();
    return { id: user.id };
  }
}
