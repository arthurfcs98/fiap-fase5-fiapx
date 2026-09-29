/** Shared ioredis client (throttling and the `Idempotency-Key` cache). */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
