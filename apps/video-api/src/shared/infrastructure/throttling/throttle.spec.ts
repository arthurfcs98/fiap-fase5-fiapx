import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottleName } from './throttle';
import {
  buildThrottler,
  clientIp,
  DEFAULT_THROTTLE_LIMITS,
  ipTracker,
  loginTracker,
  THROTTLE_WINDOWS_MS,
  ThrottleBy,
  throttleNameOf,
  userTracker,
} from './throttle';

const ctx = {} as ExecutionContext;

describe('throttle trackers and policies', () => {
  it('defaults follow the contract (login 5 per minute)', () => {
    expect(DEFAULT_THROTTLE_LIMITS).toEqual({
      register: 10,
      login: 5,
      upload: 30,
      accountDeletion: 5,
    });
    expect(THROTTLE_WINDOWS_MS).toEqual({
      register: 3_600_000,
      login: 60_000,
      upload: 60_000,
      accountDeletion: 60_000,
    });
  });

  it('clientIp prefers the Express ip, then the socket address', () => {
    expect(clientIp({ ip: '203.0.113.9' })).toBe('203.0.113.9');
    expect(clientIp({ socket: { remoteAddress: '10.0.0.1' } })).toBe('10.0.0.1');
    expect(clientIp({})).toBe('unknown');
  });

  it('ipTracker keys by IP', () => {
    expect(ipTracker({ ip: '203.0.113.9' }, ctx)).toBe('ip:203.0.113.9');
  });

  it('loginTracker keys by IP + normalized e-mail', () => {
    expect(loginTracker({ ip: '1.2.3.4', body: { email: ' Ana@Example.com ' } }, ctx)).toBe(
      'login:1.2.3.4:ana@example.com',
    );
    expect(loginTracker({ ip: '1.2.3.4', body: { email: 42 } }, ctx)).toBe('login:1.2.3.4:');
    expect(loginTracker({ ip: '1.2.3.4' }, ctx)).toBe('login:1.2.3.4:');
  });

  it('userTracker keys by user id, falling back to the IP', () => {
    expect(userTracker({ user: { id: 'u-1' }, ip: '1.2.3.4' }, ctx)).toBe('user:u-1');
    expect(userTracker({ ip: '1.2.3.4' }, ctx)).toBe('ip:1.2.3.4');
  });
});

/** Handler decorated with @ThrottleBy(name) and an ExecutionContext pointing at it. */
function decoratedContext(name?: ThrottleName): { context: ExecutionContext; handler: () => void } {
  class Target {
    handler(): void {}
  }
  if (name) {
    const descriptor = Object.getOwnPropertyDescriptor(Target.prototype, 'handler');
    ThrottleBy(name)(Target.prototype, 'handler', descriptor as PropertyDescriptor);
  }
  const handler = Target.prototype.handler;
  const context = {
    getHandler: () => handler,
    getClass: () => Target,
  } as unknown as ExecutionContext;
  return { context, handler };
}

describe('ThrottleBy + buildThrottler', () => {
  it('ThrottleBy adds the guard and tags the route with its family', () => {
    const { handler, context } = decoratedContext('upload');
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([ThrottlerGuard]);
    expect(throttleNameOf(context)).toBe('upload');
  });

  it('a guarded route without @ThrottleBy is a programming error', () => {
    expect(() => throttleNameOf(decoratedContext().context)).toThrow(/ThrottleBy/);
  });

  it('keeps the default name (standard Retry-After / X-RateLimit-* headers)', () => {
    expect(buildThrottler(DEFAULT_THROTTLE_LIMITS).name).toBe('default');
  });

  it.each([
    ['register', 500, 3_600_000, 'ip:203.0.113.9'],
    ['login', 5, 60_000, 'login:203.0.113.9:ana@example.com'],
    ['upload', 30, 60_000, 'user:u-1'],
    ['accountDeletion', 5, 60_000, 'user:u-1'],
  ] as const)('%s: limit %d, window %d ms, tracker %s', (name, limit, ttl, tracker) => {
    const throttler = buildThrottler({ ...DEFAULT_THROTTLE_LIMITS, register: 500 });
    const { context } = decoratedContext(name);
    const req = { ip: '203.0.113.9', user: { id: 'u-1' }, body: { email: 'Ana@Example.com' } };

    expect((throttler.limit as (ctx: ExecutionContext) => number)(context)).toBe(limit);
    expect((throttler.ttl as (ctx: ExecutionContext) => number)(context)).toBe(ttl);
    expect(throttler.getTracker?.(req, context)).toBe(tracker);
  });
});
