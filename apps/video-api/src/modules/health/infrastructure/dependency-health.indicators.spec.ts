import { HealthIndicatorService } from '@nestjs/terminus';
import { checkDatabase, checkStorage } from './dependency-health.indicators';

describe('readiness indicators', () => {
  const indicator = new HealthIndicatorService();
  const buckets = { raw: 'fiapx-raw', zips: 'fiapx-zips' };

  it('database: up when SELECT 1 answers', async () => {
    const dataSource = { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    await expect(checkDatabase(indicator, dataSource)).resolves.toEqual({
      database: { status: 'up' },
    });
    expect(dataSource.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('database: down with the reason on error or timeout', async () => {
    await expect(
      checkDatabase(indicator, { query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) }),
    ).resolves.toEqual({ database: { status: 'down', message: 'ECONNREFUSED' } });
    await expect(
      checkDatabase(indicator, { query: () => new Promise(() => undefined) }, 'database', 10),
    ).resolves.toEqual({ database: { status: 'down', message: 'timeout de 10 ms' } });
  });

  it('storage: up when both buckets answer', async () => {
    const storage = { checkBucket: jest.fn().mockResolvedValue(undefined) };
    await expect(checkStorage(indicator, storage, buckets)).resolves.toEqual({
      storage: { status: 'up' },
    });
    expect(storage.checkBucket).toHaveBeenCalledWith('fiapx-raw');
    expect(storage.checkBucket).toHaveBeenCalledWith('fiapx-zips');
  });

  it('storage: down when a bucket fails', async () => {
    const storage = {
      checkBucket: jest.fn((bucket: string) =>
        bucket === 'fiapx-zips' ? Promise.reject(new Error('403')) : Promise.resolve(),
      ),
    };
    await expect(checkStorage(indicator, storage, buckets)).resolves.toEqual({
      storage: { status: 'down', message: '403' },
    });
  });
});
