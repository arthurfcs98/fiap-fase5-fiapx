import type { IObjectStorage, StorageBuckets } from '@fiapx/storage';
import type { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import type { DataSource } from 'typeorm';

/** Readiness probe budget per dependency (the kubelet probe timeout is a few seconds). */
export const READINESS_TIMEOUT_MS = 2_000;

/** Postgres answers `SELECT 1` within the timeout. */
export async function checkDatabase(
  indicator: HealthIndicatorService,
  dataSource: Pick<DataSource, 'query'>,
  key = 'database',
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<HealthIndicatorResult> {
  const session = indicator.check(key);
  try {
    await withTimeout(dataSource.query('SELECT 1'), timeoutMs);
    return session.up();
  } catch (error) {
    return session.down({ message: describe(error) });
  }
}

/** Both buckets exist and the credentials work (`HeadBucket`). */
export async function checkStorage(
  indicator: HealthIndicatorService,
  storage: Pick<IObjectStorage, 'checkBucket'>,
  buckets: StorageBuckets,
  key = 'storage',
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<HealthIndicatorResult> {
  const session = indicator.check(key);
  try {
    await withTimeout(
      Promise.all([storage.checkBucket(buckets.raw), storage.checkBucket(buckets.zips)]),
      timeoutMs,
    );
    return session.up();
  } catch (error) {
    return session.down({ message: describe(error) });
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout de ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
