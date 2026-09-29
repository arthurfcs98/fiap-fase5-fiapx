/**
 * Classifies "the dependency itself is unreachable" failures (database, storage, broker, SMTP),
 * as opposed to errors caused by the request or message being handled. Used to:
 * - answer `503 X0003` (with `Retry-After`) instead of `500 X0002` when Postgres is down;
 * - keep a JWT from turning into `401` just because the user lookup could not reach the database;
 * - let queue consumers pause instead of spending the retry budget of every message.
 *
 * Duck-typed on purpose (no `pg`/AWS SDK imports): errors are recognized by their Node/pg codes,
 * walking `driverError` (TypeORM `QueryFailedError`), `cause` and `AggregateError.errors`.
 */

/** Socket/DNS errors of Node (`net`, `dns`) and of the HTTP clients built on it. */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/**
 * PostgreSQL SQLSTATEs meaning "the server cannot serve anyone right now": class 08 (connection
 * exception), 57P01-57P03 (admin/crash shutdown, starting up) and 53300 (too many connections).
 */
const PG_UNAVAILABLE_SQLSTATE = /^(08[0-9A-Z]{3}|57P0[123]|53300)$/;

/** Messages of `pg`/`pg-pool` for connections that died or never came up (no `code`). */
const CONNECTION_MESSAGES = [
  /connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /connection is not queryable|not queryable/i,
  /client has encountered a connection error/i,
  /socket hang up/i,
];

const MAX_DEPTH = 6;

export function isConnectivityError(error: unknown): boolean {
  return visit(error, 0, new Set());
}

function visit(error: unknown, depth: number, seen: Set<unknown>): boolean {
  if (depth > MAX_DEPTH || typeof error !== 'object' || error === null || seen.has(error)) {
    return false;
  }
  seen.add(error);
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    driverError?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (typeof candidate.code === 'string') {
    if (NETWORK_ERROR_CODES.has(candidate.code)) return true;
    if (PG_UNAVAILABLE_SQLSTATE.test(candidate.code)) return true;
  }
  if (
    typeof candidate.message === 'string' &&
    CONNECTION_MESSAGES.some((pattern) => pattern.test(candidate.message as string))
  ) {
    return true;
  }
  const nested = [candidate.driverError, candidate.cause];
  if (Array.isArray(candidate.errors)) nested.push(...(candidate.errors as unknown[]));
  return nested.some((inner) => visit(inner, depth + 1, seen));
}
