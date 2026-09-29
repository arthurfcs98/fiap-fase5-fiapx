import {
  AppErrorException,
  AuthErrors,
  CommonErrors,
  DEPENDENCY_RETRY_AFTER_SECONDS,
  isConnectivityError,
} from '@fiapx/common';
import type { ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { JWT_STRATEGY } from '../../auth.constants';
import { IS_PUBLIC_ROUTE } from '../decorators/public.decorator';

/**
 * Global guard (`APP_GUARD`): every route requires a valid Bearer JWT unless it is marked with
 * `@Public()`. Missing, expired or revoked (deleted user) token → `401 A0003`. A dependency
 * failure while validating (database down) → `503 X0003`, never a 401 that would log the
 * user out.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard(JWT_STRATEGY) {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;
    return super.canActivate(context);
  }

  override handleRequest<TUser>(error: unknown, user: TUser | false | null): TUser {
    if (error instanceof AppErrorException) throw error;
    if (isConnectivityError(error)) throw CommonErrors.UNAVAILABLE(DEPENDENCY_RETRY_AFTER_SECONDS);
    if (error || !user) throw AuthErrors.UNAUTHORIZED();
    return user;
  }
}
