import { Logger } from '@nestjs/common';
import type { ProcessingSettings } from '../../application/processing.settings';
import type { IWorkDirectory } from '../../domain/ports/work-directory.port';
import { WorkDirectoryJanitor } from './work-directory.janitor';

const SETTINGS = { staleWorkDirMs: 3_600_000 } as ProcessingSettings;

function workDirectory(overrides: Partial<IWorkDirectory> = {}) {
  return {
    ensureRoot: jest.fn(() => Promise.resolve()),
    sweepStale: jest.fn(() => Promise.resolve<string[]>([])),
    ...overrides,
  } as unknown as jest.Mocked<IWorkDirectory>;
}

describe('WorkDirectoryJanitor', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('ensures the root and sweeps entries older than staleWorkDirMs', async () => {
    const dir = workDirectory();

    await new WorkDirectoryJanitor(dir, SETTINGS).onModuleInit();

    expect(dir.ensureRoot).toHaveBeenCalled();
    expect(dir.sweepStale).toHaveBeenCalledWith(3_600_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs what the sweep removed', async () => {
    const dir = workDirectory({ sweepStale: jest.fn(() => Promise.resolve(['a', 'b'])) });

    await new WorkDirectoryJanitor(dir, SETTINGS).onModuleInit();

    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ count: 2, removed: ['a', 'b'] }));
  });

  it('fails the boot when WORK_DIR is not usable', async () => {
    const dir = workDirectory({
      ensureRoot: jest.fn(() => Promise.reject(new Error('EACCES: permission denied'))),
    });

    await expect(new WorkDirectoryJanitor(dir, SETTINGS).onModuleInit()).rejects.toThrow('EACCES');
    expect(dir.sweepStale).not.toHaveBeenCalled();
  });

  it('keeps booting when the sweep itself fails', async () => {
    const dir = workDirectory({ sweepStale: jest.fn(() => Promise.reject(new Error('EBUSY'))) });

    await expect(new WorkDirectoryJanitor(dir, SETTINGS).onModuleInit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ error: 'EBUSY' }));
  });

  it('describes non-Error sweep failures', async () => {
    const dir = workDirectory({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- non-Error on purpose
      sweepStale: jest.fn(() => Promise.reject('weird')),
    });

    await new WorkDirectoryJanitor(dir, SETTINGS).onModuleInit();

    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ error: 'weird' }));
  });
});
