import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { currentUserFrom } from './current-user.decorator';
import { IS_PUBLIC_ROUTE, Public } from './public.decorator';

function http(user?: { id: string }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('auth decorators', () => {
  it('@Public() marks the route metadata', () => {
    class Controller {
      @Public()
      handler(): void {}
    }
    expect(new Reflector().get(IS_PUBLIC_ROUTE, Controller.prototype.handler)).toBe(true);
  });

  it('@CurrentUser() returns req.user and refuses a request without it', () => {
    expect(currentUserFrom(http({ id: 'u1' }))).toEqual({ id: 'u1' });
    expect(() => currentUserFrom(http())).toThrow(
      expect.objectContaining({ appError: expect.objectContaining({ code: 'A0003' }) }),
    );
  });
});
