import { AuthErrors } from '@fiapx/common';
import type { ExecutionContext } from '@nestjs/common';
import { createParamDecorator } from '@nestjs/common';
import type { AuthenticatedUser } from '../../domain/user';

export function currentUserFrom(context: ExecutionContext): AuthenticatedUser {
  const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
  if (!request.user) throw AuthErrors.UNAUTHORIZED();
  return request.user;
}

/** Authenticated user (`{ id }`) set by the JWT strategy. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  currentUserFrom(context),
);
