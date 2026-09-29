import { AuthErrors } from '@fiapx/common';
import { Inject, Injectable } from '@nestjs/common';
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
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, JWT_STRATEGY) {
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
    const user = await this.users.findById(payload.sub);
    if (!user) throw AuthErrors.UNAUTHORIZED();
    return { id: user.id };
  }
}
