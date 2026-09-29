import {
  createMigrateLogger,
  MIGRATE_APPLICATION_NAME,
  runMigrateCommand,
} from './migrate.command';

const DB_ENV = {
  DB_HOST: '127.0.0.1',
  DB_PORT: '1',
  DB_USER: 'fiapx_notification',
  DB_PASSWORD: 'super-secret-password',
  DB_NAME: 'fiapx_notification',
  DB_SSL: 'false',
};

function logger() {
  return { info: jest.fn(), error: jest.fn() };
}

describe('runMigrateCommand', () => {
  it('applies the pending migrations and exits 0', async () => {
    const log = logger();
    const migrate = jest.fn().mockResolvedValue(['Init1790553600000']);

    await expect(runMigrateCommand({ env: DB_ENV, migrate, logger: log })).resolves.toBe(0);

    expect(migrate).toHaveBeenCalledWith(
      expect.objectContaining({ DB_HOST: '127.0.0.1', DB_PORT: 1, DB_SSL: false }),
    );
    expect(log.info).toHaveBeenCalledWith(
      { applied: ['Init1790553600000'] },
      'Migrations applied: Init1790553600000',
    );
  });

  it('is a no-op when the database is up to date', async () => {
    const log = logger();

    await expect(
      runMigrateCommand({ env: DB_ENV, migrate: () => Promise.resolve([]), logger: log }),
    ).resolves.toBe(0);
    expect(log.info).toHaveBeenCalledWith(
      { applied: [] },
      'Database up to date: no pending migrations',
    );
  });

  it('exits 1 on an invalid config, listing keys without values', async () => {
    const log = logger();
    const migrate = jest.fn();

    await expect(
      runMigrateCommand({ env: { DB_PASSWORD: 'super-secret-password' }, migrate, logger: log }),
    ).resolves.toBe(1);

    expect(migrate).not.toHaveBeenCalled();
    const [fields, message] = log.error.mock.calls[0] as [{ error: string }, string];
    expect(message).toBe('Migration failed');
    expect(fields.error).toContain('DB_HOST');
    expect(fields.error).not.toContain('super-secret-password');
  });

  it('exits 1 when a migration fails', async () => {
    const log = logger();

    await expect(
      runMigrateCommand({
        env: DB_ENV,
        migrate: () => Promise.reject(new Error('relation already exists')),
        logger: log,
      }),
    ).resolves.toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      { error: 'Error: relation already exists' },
      'Migration failed',
    );

    // A non-Error rejection on purpose (thrown strings still produce a readable log line).
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const rejectWithString = () => Promise.reject('boom');
    await expect(
      runMigrateCommand({ env: DB_ENV, migrate: rejectWithString, logger: log }),
    ).resolves.toBe(1);
    expect(log.error).toHaveBeenLastCalledWith({ error: 'boom' }, 'Migration failed');
  });

  it('uses TypeORM and its own JSON logger by default (database unreachable → exit 1)', async () => {
    await expect(
      runMigrateCommand({ env: { ...DB_ENV, LOG_LEVEL: 'silent', APP_VERSION: 'sha-test' } }),
    ).resolves.toBe(1);
    expect(MIGRATE_APPLICATION_NAME).toBe('notification-service-migrate');
  });

  it('logger level comes from LOG_LEVEL (info when absent or invalid)', () => {
    expect(createMigrateLogger({ LOG_LEVEL: 'warn' }).level).toBe('warn');
    expect(createMigrateLogger({}).level).toBe('info');
    expect(createMigrateLogger({ LOG_LEVEL: 'loud' }).level).toBe('info');
  });
});
