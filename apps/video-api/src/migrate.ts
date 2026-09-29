import { exitOnBootstrapError } from '@fiapx/observability';
import { runMigrationCli } from './database/migration-cli';

runMigrationCli().catch(exitOnBootstrapError('video-api-migrate'));
