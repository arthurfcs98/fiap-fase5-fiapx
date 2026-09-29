import type { ExecutionContext } from '@nestjs/common';
import { applyDecorators, Injectable, SetMetadata, UseGuards } from '@nestjs/common';
import type {
  ThrottlerGetTrackerFunction,
  ThrottlerLimitDetail,
  ThrottlerOptions,
} from '@nestjs/throttler';
import { normalizeIp, ThrottlerGuard } from '@nestjs/throttler';

/** Throttled routes (contratos.md, section 8: register, login 5/min, upload; section 12). */
export const THROTTLE_NAMES = ['register', 'login', 'upload', 'accountDeletion'] as const;
export type ThrottleName = (typeof THROTTLE_NAMES)[number];

/** Requests allowed per window, per throttle. */
export type ThrottleLimits = Readonly<Record<ThrottleName, number>>;

/**
 * Anti-abuse defaults. The counters live in Redis, so they hold across replicas. The limits can
 * be raised per environment (`THROTTLE_*_LIMIT`, e.g. the load test); the windows are fixed.
 */
export const DEFAULT_THROTTLE_LIMITS: ThrottleLimits = {
  /** Sign-up: 10 per hour per client IP. */
  register: 10,
  /** Login: 5 per minute per client IP + e-mail (no account lockout, which would allow DoS). */
  login: 5,
  /** Upload: 30 per minute per user. */
  upload: 30,
  /** `DELETE /api/me` asks for the password again: same limit as the login, per user. */
  accountDeletion: 5,
};

/**
 * Login attempts per minute per client IP, WHATEVER the e-mail (`THROTTLE_LOGIN_IP_LIMIT`).
 * The per IP + e-mail limit alone lets one IP rotate e-mails and burn ~230 ms of bcrypt per
 * request: this second counter bounds that CPU.
 */
export const DEFAULT_LOGIN_IP_LIMIT = 30;

/** IPv6 clients are grouped by /64 (one subscriber usually gets a whole /64). */
export const IPV6_SUBNET_PREFIX = 64;

/** Window of each throttle, in milliseconds. */
export const THROTTLE_WINDOWS_MS: Readonly<Record<ThrottleName, number>> = {
  register: 60 * 60_000,
  login: 60_000,
  upload: 60_000,
  accountDeletion: 60_000,
};

interface RequestLike {
  ip?: string;
  socket?: { remoteAddress?: string };
  body?: unknown;
  user?: { id?: string };
}

/**
 * Client IP as resolved by Express. `trust proxy` (see `configureApp`) only trusts
 * `X-Forwarded-For` hops that are private addresses (ingress, Caddy), so a client on the
 * internet cannot spoof it. IPv6 addresses are reduced to their /64 (otherwise one host with a
 * /64 would have 2^64 "IPs"); IPv4-mapped IPv6 becomes the plain IPv4.
 */
export function clientIp(req: RequestLike): string {
  const ip = req.ip ?? req.socket?.remoteAddress;
  return ip ? normalizeIp(ip, IPV6_SUBNET_PREFIX) : 'unknown';
}

export const ipTracker: ThrottlerGetTrackerFunction = (req: RequestLike) => `ip:${clientIp(req)}`;

/** IP + e-mail (the key is hashed by the throttler before reaching Redis). */
export const loginTracker: ThrottlerGetTrackerFunction = (req: RequestLike) => {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const email = (body as { email?: unknown }).email;
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  return `login:${clientIp(req)}:${normalized}`;
};

/** Per client IP only (second counter of the login route). */
export const loginIpTracker: ThrottlerGetTrackerFunction = (req: RequestLike) =>
  `loginip:${clientIp(req)}`;

/** Authenticated routes: per user (the global JWT guard runs before this guard). */
export const userTracker: ThrottlerGetTrackerFunction = (req: RequestLike) =>
  req.user?.id ? `user:${req.user.id}` : `ip:${clientIp(req)}`;

const TRACKERS: Readonly<Record<ThrottleName, ThrottlerGetTrackerFunction>> = {
  register: ipTracker,
  login: loginTracker,
  upload: userTracker,
  accountDeletion: userTracker,
};

/** Metadata key set by `@ThrottleBy(name)` on the route handler. */
export const THROTTLE_ROUTE = 'fiapx:throttle-route';

/** Throttle family of the route being handled (set by `@ThrottleBy`). */
export function throttleNameOf(context: ExecutionContext): ThrottleName {
  const name = Reflect.getMetadata(THROTTLE_ROUTE, context.getHandler()) as
    ThrottleName | undefined;
  if (!name) throw new Error('ThrottlerGuard aplicado sem @ThrottleBy(nome) na rota');
  return name;
}

/**
 * The single `default` throttler of the `ThrottlerModule`: limit, window and tracker are resolved
 * per route from `@ThrottleBy(name)`. Keeping the name `default` keeps the standard headers
 * (`Retry-After`, `X-RateLimit-*`); named throttlers would suffix them (`Retry-After-login`).
 * The Redis key includes the controller and handler names, so each route has its own counter.
 */
export function buildThrottler(limits: ThrottleLimits): ThrottlerOptions {
  return {
    name: 'default',
    limit: (context) => limits[throttleNameOf(context)],
    ttl: (context) => THROTTLE_WINDOWS_MS[throttleNameOf(context)],
    getTracker: (req, context) => TRACKERS[throttleNameOf(context)](req, context),
  };
}

/**
 * Second throttler (named `loginIp`): only on the login route, per client IP. Named throttlers
 * get suffixed headers (`Retry-After-loginIp`); {@link AppThrottlerGuard} adds the standard
 * `Retry-After` too.
 */
export function buildLoginIpThrottler(limit: number): ThrottlerOptions {
  return {
    name: 'loginIp',
    limit,
    ttl: THROTTLE_WINDOWS_MS.login,
    skipIf: (context) => throttleNameOf(context) !== 'login',
    getTracker: loginIpTracker,
  };
}

/**
 * `ThrottlerGuard` that always answers the blocked request with the standard `Retry-After`
 * (seconds), whichever throttler blocked it: clients (and the frontend) only read that one.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const response = context.switchToHttp().getResponse<{
      header?: (name: string, value: string) => unknown;
    }>();
    response.header?.('Retry-After', String(Math.max(1, Math.ceil(detail.timeToBlockExpire))));
    await super.throwThrottlingException(context, detail);
  }
}

/** Applies the throttler guard to one route with the limits of the named family. */
export function ThrottleBy(name: ThrottleName) {
  return applyDecorators(UseGuards(AppThrottlerGuard), SetMetadata(THROTTLE_ROUTE, name));
}
