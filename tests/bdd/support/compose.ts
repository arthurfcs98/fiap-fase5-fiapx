import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from './env';

const run = promisify(execFile);

/** `docker compose <args>` in the repository root (same project as `make up`). */
export async function compose(args: string[]): Promise<string> {
  const { stdout } = await run('docker', ['compose', ...args], {
    cwd: ROOT,
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
  });
  return stdout;
}

/** Running containers of a compose service. */
export async function runningReplicas(service: string): Promise<number> {
  const out = await compose(['ps', '--status', 'running', '--quiet', service]);
  return out.split('\n').filter((line) => line.trim() !== '').length;
}

/**
 * `/metrics` of one replica, read from inside the container with the container's own
 * `METRICS_TOKEN` (the metrics port is never published). `index` starts at 1.
 */
export async function metricsOf(service: string, index = 1): Promise<string> {
  return compose([
    'exec',
    '-T',
    '--index',
    String(index),
    service,
    'sh',
    '-c',
    'wget -qO- --header "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:9464/metrics',
  ]);
}

/** HTTP status of `/metrics` WITHOUT the token (expected 401). */
export async function metricsStatusWithoutToken(service: string): Promise<number> {
  const out = await compose([
    'exec',
    '-T',
    service,
    'node',
    '-e',
    'fetch("http://127.0.0.1:9464/metrics").then((r) => console.log(r.status), () => console.log(0))',
  ]);
  return Number(out.trim());
}

/** Environment variable as seen by the container (e.g. the retention the stack runs with). */
export async function containerEnv(service: string, key: string): Promise<string | undefined> {
  try {
    const out = await compose(['exec', '-T', service, 'printenv', key]);
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Logs of every service of the stack (no colors, no prefix alignment issues). */
export async function stackLogs(services: string[] = []): Promise<string> {
  return compose(['logs', '--no-color', '--no-log-prefix', ...services]);
}

/** Sum of a Prometheus sample (all label sets that contain every `labels` pair). */
export function metricValue(
  text: string,
  name: string,
  labels: Record<string, string> = {},
): number {
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    const matches = Object.entries(labels).every(([key, val]) => line.includes(`${key}="${val}"`));
    if (!matches) continue;
    const sample = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(sample)) total += sample;
  }
  return total;
}

/** Synchronous `printenv` in a container (for decisions taken while the tests are defined). */
export function containerEnvSync(service: string, key: string): string | undefined {
  try {
    const out = execFileSync('docker', ['compose', 'exec', '-T', service, 'printenv', key], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}
