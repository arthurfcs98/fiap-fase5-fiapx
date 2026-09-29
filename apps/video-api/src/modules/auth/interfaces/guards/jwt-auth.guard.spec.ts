import { AuthErrors } from '@fiapx/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';

function context(): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  it('lets @Public() routes through without a token', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    expect(new JwtAuthGuard(reflector).canActivate(context())).toBe(true);
  });

  it('delegates protected routes to passport-jwt', () => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const guard = new JwtAuthGuard(reflector);
    const parent = Object.getPrototypeOf(JwtAuthGuard.prototype) as { canActivate: () => unknown };
    const superCall = jest.spyOn(parent, 'canActivate').mockReturnValue(true);

    expect(guard.canActivate(context())).toBe(true);
    expect(superCall).toHaveBeenCalled();
  });

  it('missing/invalid token → A0003; strategy errors pass through; user is returned', () => {
    const guard = new JwtAuthGuard(new Reflector());
    expect(() => guard.handleRequest(null, false)).toThrow(
      expect.objectContaining({ appError: expect.objectContaining({ code: 'A0003' }) }),
    );
    expect(() => guard.handleRequest(new Error('jwt expired'), false)).toThrow(
      expect.objectContaining({ appError: expect.objectContaining({ code: 'A0003' }) }),
    );
    const fromStrategy = AuthErrors.UNAUTHORIZED();
    expect(() => guard.handleRequest(fromStrategy, false)).toThrow(fromStrategy);
    expect(guard.handleRequest(null, { id: 'u1' })).toEqual({ id: 'u1' });
  });

  it('a connectivity error while validating → 503 X0003 (never a 401 that logs the user out)', () => {
    const guard = new JwtAuthGuard(new Reflector());
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    expect(() => guard.handleRequest(refused, false)).toThrow(
      expect.objectContaining({ appError: expect.objectContaining({ code: 'X0003' }) }),
    );
  });
});
