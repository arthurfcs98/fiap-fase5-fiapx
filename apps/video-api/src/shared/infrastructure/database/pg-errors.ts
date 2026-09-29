/** SQLSTATE codes of the PostgreSQL errors the repositories translate into domain errors. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';

interface PgErrorLike {
  code?: unknown;
  constraint?: unknown;
  driverError?: PgErrorLike;
}

/**
 * `true` when `error` (a TypeORM `QueryFailedError` or the raw `pg` error) has SQLSTATE `code`
 * and, if given, was raised by `constraint`.
 */
export function isPgError(error: unknown, code: string, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as PgErrorLike;
  const source = candidate.driverError ?? candidate;
  if (source.code !== code) return false;
  return constraint === undefined || source.constraint === constraint;
}
