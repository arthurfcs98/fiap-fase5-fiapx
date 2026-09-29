import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Repository root (the compose project lives here). */
export const ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Sample videos uploaded by the scenarios: the versioned examples (tests/fixtures/generate.sh
 * --examples), so the BDD needs no ffmpeg on the machine that runs it.
 */
export const FIXTURES_DIR = path.join(ROOT, 'examples');

/**
 * Reads the compose `.env` as KEY=VALUE (no expansion, outer quotes removed), the same way
 * `scripts/compose-smoke.sh` does. Values exported in the shell win, like in Compose.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match as unknown as [string, string, string];
    values[key] = raw.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return values;
}

const dotEnvFile = path.join(ROOT, '.env');
const dotEnv = existsSync(dotEnvFile) ? parseDotEnv(readFileSync(dotEnvFile, 'utf8')) : {};

function value(key: string, fallback?: string): string {
  const found = process.env[key] ?? dotEnv[key] ?? fallback;
  if (found === undefined || found === '') {
    throw new Error(
      `${key} ausente: suba o stack com "make up" (gera o .env) antes de rodar "npm run test:bdd"`,
    );
  }
  return found;
}

const localhost = (portKey: string, defaultPort: string): string =>
  `http://127.0.0.1:${value(portKey, defaultPort)}`;

/** Endpoints and credentials of the running compose stack (only local, generated values). */
export const stack = {
  get apiUrl(): string {
    return process.env['BDD_API_URL'] ?? localhost('API_HOST_PORT', '8080');
  },
  get mailpitUrl(): string {
    return localhost('MAILPIT_UI_HOST_PORT', '8025');
  },
  get rabbitmqUrl(): string {
    return localhost('RABBITMQ_UI_HOST_PORT', '15672');
  },
  get rabbitmqPassword(): string {
    return value('RABBITMQ_PASSWORD');
  },
  get s3(): { endpoint: string; accessKeyId: string; secretAccessKey: string } {
    return {
      endpoint: localhost('GARAGE_S3_HOST_PORT', '3900'),
      accessKeyId: value('S3_ACCESS_KEY_ID'),
      secretAccessKey: value('S3_SECRET_ACCESS_KEY'),
    };
  },
  get postgres(): { host: string; port: number } {
    return { host: '127.0.0.1', port: Number(value('POSTGRES_HOST_PORT', '5432')) };
  },
  get videoDbPassword(): string {
    return value('VIDEO_DB_PASSWORD');
  },
  get notificationDbPassword(): string {
    return value('NOTIF_DB_PASSWORD');
  },
};
