import { Logger } from '@nestjs/common';
import Redis from 'ioredis';

const LOG_EVERY_MS = 60_000;

/**
 * ioredis client that fails fast while Redis is down (`enableOfflineQueue: false`,
 * `maxRetriesPerRequest: 1`): throttling fails open and the idempotency cache falls back to
 * Postgres instead of making requests wait. Reconnects in the background.
 */
export function createRedisClient(url: string, connectionName: string): Redis {
  const client = new Redis(url, {
    connectionName,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    retryStrategy: (attempt: number) => Math.min(attempt * 250, 5_000),
  });
  attachErrorLogger(client);
  return client;
}

/** Without an `error` listener ioredis prints every reconnection failure to stderr. */
export function attachErrorLogger(
  client: Pick<Redis, 'on'>,
  logger: Pick<Logger, 'warn'> = new Logger('Redis'),
  now: () => number = Date.now,
): void {
  let lastLoggedAt = Number.NEGATIVE_INFINITY;
  client.on('error', (error: Error) => {
    if (now() - lastLoggedAt < LOG_EVERY_MS) return;
    lastLoggedAt = now();
    logger.warn({ msg: 'Redis indisponível', error: error.message });
  });
}

/** Graceful close on shutdown (QUIT, or a hard disconnect when Redis is unreachable). */
export async function closeRedisClient(client: Pick<Redis, 'quit' | 'disconnect' | 'status'>) {
  if (client.status === 'end') return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
