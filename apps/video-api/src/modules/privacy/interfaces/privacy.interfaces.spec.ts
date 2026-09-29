import { Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { correlationStorage } from '@fiapx/observability';
import { USER_ID } from '../../../../test/support/fakes';
import type { ExpireZipsUseCase } from '../../videos/application/use-cases/expire-zips.use-case';
import type { DeleteMyAccountUseCase } from '../application/use-cases/delete-my-account.use-case';
import type { ExportMyDataUseCase } from '../application/use-cases/export-my-data.use-case';
import type { PurgeDeliveryRecordsUseCase } from '../application/use-cases/purge-delivery-records.use-case';
import type { PurgeOrphanObjectsUseCase } from '../application/use-cases/purge-orphan-objects.use-case';
import { MeController } from './controllers/me.controller';
import { deleteAccountSchema } from './dto/privacy.dto';
import type { PurgeLeftoverUploadsUseCase } from '../application/use-cases/purge-leftover-uploads.use-case';
import {
  DATA_RETENTION_FIRST_RUN,
  DATA_RETENTION_JOB,
  DataRetentionJob,
  FIRST_RUN_DELAY_MS,
} from './jobs/data-retention.job';

describe('MeController', () => {
  it('GET /api/me/data exports; DELETE /api/me passes the correlation id', async () => {
    const exportData = { execute: jest.fn().mockResolvedValue({ user: {} }) };
    const deleteAccount = { execute: jest.fn().mockResolvedValue({}) };
    const controller = new MeController(
      exportData as unknown as ExportMyDataUseCase,
      deleteAccount as unknown as DeleteMyAccountUseCase,
    );

    await expect(controller.data({ id: USER_ID })).resolves.toEqual({ user: {} });
    await correlationStorage.run({ correlationId: 'cid-del' }, () =>
      controller.delete({ id: USER_ID }, { password: 'x' }),
    );
    await controller.delete({ id: USER_ID }, { password: 'y' });

    expect(deleteAccount.execute).toHaveBeenNthCalledWith(1, {
      userId: USER_ID,
      password: 'x',
      correlationId: 'cid-del',
    });
    expect(deleteAccount.execute.mock.calls[1]?.[0].correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('the body needs the password', () => {
    expect(deleteAccountSchema.safeParse({}).success).toBe(false);
    expect(deleteAccountSchema.safeParse({ password: '' }).success).toBe(false);
    expect(deleteAccountSchema.parse({ password: 'x' })).toEqual({ password: 'x' });
  });
});

describe('DataRetentionJob', () => {
  function job(
    overrides: {
      zips?: jest.Mock;
      orphans?: jest.Mock;
      leftovers?: jest.Mock;
      delivery?: jest.Mock;
      intervalMs?: number;
      registry?: SchedulerRegistry;
    } = {},
  ) {
    const zips = overrides.zips ?? jest.fn().mockResolvedValue({});
    const orphans = overrides.orphans ?? jest.fn().mockResolvedValue({});
    const leftovers = overrides.leftovers ?? jest.fn().mockResolvedValue({});
    const delivery = overrides.delivery ?? jest.fn().mockResolvedValue({});
    return {
      zips,
      orphans,
      leftovers,
      delivery,
      job: new DataRetentionJob(
        { execute: zips } as unknown as ExpireZipsUseCase,
        { execute: orphans } as unknown as PurgeOrphanObjectsUseCase,
        { execute: leftovers } as unknown as PurgeLeftoverUploadsUseCase,
        { execute: delivery } as unknown as PurgeDeliveryRecordsUseCase,
        { intervalMs: overrides.intervalMs ?? 10_000 },
        overrides.registry ?? new SchedulerRegistry(),
      ),
    };
  }

  it('runs the four retention tasks', async () => {
    const { job: retention, zips, orphans, leftovers, delivery } = job();
    await retention.run();
    expect([zips, orphans, leftovers, delivery].map((fn) => fn.mock.calls.length)).toEqual([
      1, 1, 1, 1,
    ]);
  });

  it('first run 60 s after the boot (not a full hour), then every interval', async () => {
    jest.useFakeTimers();
    try {
      const registry = new SchedulerRegistry();
      const { job: retention, zips } = job({ intervalMs: 3_600_000, registry });

      retention.onApplicationBootstrap();
      expect(registry.getTimeouts()).toEqual([DATA_RETENTION_FIRST_RUN]);
      await jest.advanceTimersByTimeAsync(FIRST_RUN_DELAY_MS - 1);
      expect(zips).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(zips).toHaveBeenCalledTimes(1);

      registry.deleteInterval(DATA_RETENTION_JOB);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a failing task does not skip the others', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { job: retention, delivery } = job({
      zips: jest.fn().mockRejectedValue(new Error('storage down')),
      orphans: jest.fn().mockRejectedValue('list failed'),
    });
    await retention.run();
    expect(delivery).toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ error: 'list failed' }));
  });

  it('registers an interval with the configured period (cleared by @nestjs/schedule)', async () => {
    jest.useFakeTimers();
    try {
      const registry = new SchedulerRegistry();
      const { job: retention, zips } = job({ registry });

      retention.onApplicationBootstrap();
      expect(registry.getIntervals()).toEqual([DATA_RETENTION_JOB]);
      expect(registry.getTimeouts()).toEqual([]);
      await jest.advanceTimersByTimeAsync(9_999);
      expect(zips).not.toHaveBeenCalled();
      // Interval shorter than 60 s: the first tick is the first run.
      await jest.advanceTimersByTimeAsync(1);
      expect(zips).toHaveBeenCalledTimes(1);

      registry.deleteInterval(DATA_RETENTION_JOB);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(zips).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never overlaps itself', async () => {
    let release: () => void = () => undefined;
    const zips = jest.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const { job: retention } = job({ zips });
    const first = retention.run();
    await retention.run();
    release();
    await first;
    expect(zips).toHaveBeenCalledTimes(1);
  });
});
