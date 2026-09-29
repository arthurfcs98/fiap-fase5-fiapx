import { runMigrateCommand } from './database/migrate.command';

/**
 * Entry of the `migrate` one-shot: `node dist/migrate.js` (compose `notification-migrate` / K8s
 * Job, before the rollout). Built as a second webpack entry (`webpack.config.js`).
 */
export const migration = runMigrateCommand().then((code) => {
  process.exitCode = code;
});
