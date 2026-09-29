import type { DatabaseConfig } from '@fiapx/common';
import { createDataSource, loadConfig, logLevelSchema, runMigrations } from '@fiapx/common';
import type { Logger as PinoLogger } from 'pino';
import pino from 'pino';
import { migrateConfigSchema, SERVICE_NAME } from '../config/notification.config';
import { notificationDataSourceInput } from './notification-data-source';

/** `application_name` of the one-shot in `pg_stat_activity` and `service` in its logs. */
export const MIGRATE_APPLICATION_NAME = `${SERVICE_NAME}-migrate`;

export interface MigrateCommandDeps {
  env?: NodeJS.ProcessEnv;
  /** Applies the pending migrations and closes the connection; returns the applied names. */
  migrate?: (config: DatabaseConfig) => Promise<string[]>;
  logger?: Pick<PinoLogger, 'info' | 'error'>;
}

/**
 * The `migrate` one-shot (compose service / K8s Job, `node dist/migrate.js`): validates the
 * `DB_*` config, applies the pending migrations of `fiapx_notification` (each in its own
 * transaction; idempotent) and reports in JSON logs. Never runs in the service's own boot.
 *
 * @returns the process exit code (0 ok, 1 invalid config or migration failure).
 */
export async function runMigrateCommand(deps: MigrateCommandDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const logger = deps.logger ?? createMigrateLogger(env);
  try {
    const config = loadConfig(migrateConfigSchema, env);
    const applied = await (deps.migrate ?? migrateDatabase)(config);
    logger.info(
      { applied },
      applied.length > 0
        ? `Migrations applied: ${applied.join(', ')}`
        : 'Database up to date: no pending migrations',
    );
    return 0;
  } catch (error) {
    // Config errors list the invalid keys without values; driver errors carry no parameters.
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    logger.error({ error: detail }, 'Migration failed');
    return 1;
  }
}

/** JSON logs like the services (level from `LOG_LEVEL`, `info` when absent or invalid). */
export function createMigrateLogger(env: NodeJS.ProcessEnv): PinoLogger {
  const level = logLevelSchema.safeParse(env['LOG_LEVEL'] || undefined);
  return pino({
    level: level.success ? level.data : 'info',
    base: { service: MIGRATE_APPLICATION_NAME, version: env['APP_VERSION'] || 'dev' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}

function migrateDatabase(config: DatabaseConfig): Promise<string[]> {
  return runMigrations(
    createDataSource(config, notificationDataSourceInput(MIGRATE_APPLICATION_NAME)),
  );
}
