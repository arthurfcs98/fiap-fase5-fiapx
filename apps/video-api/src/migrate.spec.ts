jest.mock('./database/migration-cli', () => ({ runMigrationCli: jest.fn() }));
jest.mock('@fiapx/observability', () => ({ exitOnBootstrapError: jest.fn(() => jest.fn()) }));

import { exitOnBootstrapError } from '@fiapx/observability';
import { runMigrationCli } from './database/migration-cli';

describe('migrate entrypoint', () => {
  it('runs the migration CLI and exits with 1 on failure', async () => {
    const failure = new Error('db down');
    (runMigrationCli as jest.Mock).mockRejectedValue(failure);
    const onError = jest.fn();
    (exitOnBootstrapError as jest.Mock).mockReturnValue(onError);

    jest.isolateModules(() => {
      jest.requireActual('./migrate');
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(runMigrationCli).toHaveBeenCalled();
    expect(exitOnBootstrapError).toHaveBeenCalledWith('video-api-migrate');
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
