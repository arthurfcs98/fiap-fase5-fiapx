jest.mock('@fiapx/messaging', () => ({ runTopologySetupCli: jest.fn() }));
jest.mock('@fiapx/observability', () => ({ exitOnBootstrapError: jest.fn(() => jest.fn()) }));

import { runTopologySetupCli } from '@fiapx/messaging';
import { exitOnBootstrapError } from '@fiapx/observability';

describe('setup-topology entrypoint', () => {
  it('runs the topology one-shot as the video-api and exits with 1 on failure', async () => {
    const failure = new Error('broker down');
    (runTopologySetupCli as jest.Mock).mockRejectedValue(failure);
    const onError = jest.fn();
    (exitOnBootstrapError as jest.Mock).mockReturnValue(onError);

    jest.isolateModules(() => {
      jest.requireActual('./setup-topology');
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(runTopologySetupCli).toHaveBeenCalledWith({ service: 'video-api' });
    expect(exitOnBootstrapError).toHaveBeenCalledWith('video-api-setup-topology');
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
