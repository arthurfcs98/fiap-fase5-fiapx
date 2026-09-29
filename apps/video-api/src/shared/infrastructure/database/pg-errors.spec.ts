import { isPgError, PG_FOREIGN_KEY_VIOLATION, PG_UNIQUE_VIOLATION } from './pg-errors';

describe('isPgError', () => {
  it('reads the SQLSTATE from the TypeORM driverError or from the pg error itself', () => {
    const pgError = { code: PG_UNIQUE_VIOLATION, constraint: 'users_email_key' };
    expect(isPgError(pgError, PG_UNIQUE_VIOLATION)).toBe(true);
    expect(isPgError({ driverError: pgError }, PG_UNIQUE_VIOLATION, 'users_email_key')).toBe(true);
  });

  it('checks the constraint when given', () => {
    const pgError = { driverError: { code: PG_UNIQUE_VIOLATION, constraint: 'other' } };
    expect(isPgError(pgError, PG_UNIQUE_VIOLATION, 'users_email_key')).toBe(false);
  });

  it('is false for other codes and non-objects', () => {
    expect(isPgError({ code: PG_FOREIGN_KEY_VIOLATION }, PG_UNIQUE_VIOLATION)).toBe(false);
    expect(isPgError(new Error('x'), PG_UNIQUE_VIOLATION)).toBe(false);
    expect(isPgError(null, PG_UNIQUE_VIOLATION)).toBe(false);
    expect(isPgError('23505', PG_UNIQUE_VIOLATION)).toBe(false);
  });
});
