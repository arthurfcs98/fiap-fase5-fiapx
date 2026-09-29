import {
  baseServiceConfigShape,
  createDataSource,
  databaseConfigShape,
  loadConfig,
  runMigrations,
} from '@fiapx/common';
import { z } from 'zod';
import { SERVICE_NAME } from '../config/api.config';
import { MIGRATIONS } from './migrations';
import { ORM_ENTITIES } from './orm-entities';

/** Only what the one-shot needs: it must not require RabbitMQ, S3, Redis or JWT variables. */
export const migrateConfigSchema = z.object({ ...baseServiceConfigShape, ...databaseConfigShape });

export interface MigrationCliDependencies {
  env?: NodeJS.ProcessEnv;
  run?: typeof runMigrations;
  write?: (line: string) => void;
}

/**
 * One-shot migration (`node dist/apps/video-api/migrate.js`; in the image `node dist/migrate.js`):
 * compose service / K8s Job before the rollout. Idempotent (applied migrations are skipped).
 * Writes one JSON line per event (same shape as the pino logs) and seeds nothing.
 */
export async function runMigrationCli(deps: MigrationCliDependencies = {}): Promise<string[]> {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const config = loadConfig(migrateConfigSchema, deps.env ?? process.env);
  const dataSource = createDataSource(config, {
    applicationName: `${SERVICE_NAME}-migrate`,
    entities: ORM_ENTITIES,
    migrations: MIGRATIONS,
  });
  const applied = await (deps.run ?? runMigrations)(dataSource);
  write(
    JSON.stringify({
      level: 'info',
      time: new Date().toISOString(),
      service: SERVICE_NAME,
      version: config.APP_VERSION,
      msg: applied.length > 0 ? 'Migrações aplicadas' : 'Nenhuma migração pendente',
      database: config.DB_NAME,
      applied,
    }),
  );
  return applied;
}
