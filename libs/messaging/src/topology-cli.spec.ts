jest.mock('./topology-setup', () => ({ setupTopology: jest.fn() }));

import { ConfigValidationError } from '@fiapx/common';
import { buildTopology } from './topology';
import type { TopologyCliDependencies } from './topology-cli';
import { runTopologySetupCli, TOPOLOGY_CLI_RETRY_DELAY_MS } from './topology-cli';
import { setupTopology } from './topology-setup';

const URL = 'amqp://fiapx:s3cret-password@rabbitmq:5672';
const topology = buildTopology();

function harness(overrides: Partial<TopologyCliDependencies> = {}) {
  let clock = 1_000_000;
  const lines: Record<string, unknown>[] = [];
  const deps: TopologyCliDependencies = {
    service: 'video-api',
    env: { RABBITMQ_URL: URL, APP_VERSION: 'sha-abc1234' },
    setup: jest.fn().mockResolvedValue(topology),
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    now: () => clock,
    sleep: jest.fn((ms: number) => {
      clock += ms;
      return Promise.resolve();
    }),
    ...overrides,
  };
  return { deps, lines, raw: () => JSON.stringify(lines) };
}

function refused(): Error {
  return Object.assign(new Error('connect ECONNREFUSED 10.43.0.10:5672'), { code: 'ECONNREFUSED' });
}

describe('runTopologySetupCli', () => {
  it('declares the whole topology with the given URL and logs the counts (never the URL)', async () => {
    const { deps, lines, raw } = harness();

    await expect(runTopologySetupCli(deps)).resolves.toBe(topology);

    expect(deps.setup).toHaveBeenCalledWith({
      url: URL,
      connectionName: 'video-api-setup-topology',
    });
    expect(lines).toEqual([
      expect.objectContaining({
        level: 'info',
        service: 'video-api',
        version: 'sha-abc1234',
        msg: 'Topologia RabbitMQ declarada',
        exchanges: topology.exchanges.length,
        queues: topology.queues.length,
        bindings: topology.bindings.length,
        attempts: 1,
      }),
    ]);
    expect(raw()).not.toContain('s3cret-password');
  });

  it('waits for a broker that is still booting, logging only the error code', async () => {
    const setup = jest
      .fn()
      .mockRejectedValueOnce(refused())
      .mockRejectedValueOnce(new Error('Socket closed abruptly during opening handshake'))
      .mockResolvedValue(topology);
    const { deps, lines, raw } = harness({ setup });

    await runTopologySetupCli(deps);

    expect(setup).toHaveBeenCalledTimes(3);
    expect(deps.sleep).toHaveBeenCalledWith(TOPOLOGY_CLI_RETRY_DELAY_MS);
    expect(lines.map((line) => [line.level, line.error])).toEqual([
      ['warn', 'ECONNREFUSED'],
      ['warn', 'Error'],
      ['info', undefined],
    ]);
    expect(lines[2]).toMatchObject({ attempts: 3 });
    expect(raw()).not.toContain('10.43.0.10');
  });

  it('gives up with the last error once the timeout is over', async () => {
    const setup = jest.fn().mockRejectedValue(refused());
    const { deps } = harness({ setup, timeoutMs: 5_000, retryDelayMs: 2_000 });

    await expect(runTopologySetupCli(deps)).rejects.toThrow('ECONNREFUSED');
    // t=0, 2 s and 4 s; a 4th attempt would start after the 5 s deadline.
    expect(setup).toHaveBeenCalledTimes(3);
  });

  it.each([
    'Operation failed: QueueDeclare; 406 (PRECONDITION-FAILED) with message "inequivalent arg"',
    'Handshake terminated by server: 403 (ACCESS-REFUSED) with message "ACCESS_REFUSED - Login was refused"',
    'Operation failed: ExchangeDeclare; 530 (NOT-ALLOWED)',
  ])('fails at once on a permanent broker answer: %s', async (message) => {
    const setup = jest.fn().mockRejectedValue(new Error(message));
    const { deps } = harness({ setup });

    await expect(runTopologySetupCli(deps)).rejects.toThrow(message);
    expect(setup).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('retries a non-Error rejection and logs its type', async () => {
    const setup = jest.fn().mockRejectedValueOnce('boom').mockResolvedValue(topology);
    const { deps, lines } = harness({ setup });

    await runTopologySetupCli(deps);

    expect(lines[0]).toMatchObject({ level: 'warn', error: 'string', attempt: 1 });
  });

  it('requires RABBITMQ_URL', async () => {
    const { deps } = harness({ env: {} });

    await expect(runTopologySetupCli(deps)).rejects.toBeInstanceOf(ConfigValidationError);
    expect(deps.setup).not.toHaveBeenCalled();
  });

  it('uses process.env, setupTopology, the real clock, sleep and stdout by default', async () => {
    const setup = setupTopology as jest.MockedFunction<typeof setupTopology>;
    setup.mockRejectedValueOnce(refused()).mockResolvedValueOnce(topology);
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const previousUrl = process.env.RABBITMQ_URL;
    process.env.RABBITMQ_URL = URL;
    const written: unknown[][] = [];
    try {
      await runTopologySetupCli({ service: 'video-api', retryDelayMs: 1 });
      written.push(...stdout.mock.calls);
    } finally {
      stdout.mockRestore();
      if (previousUrl === undefined) delete process.env.RABBITMQ_URL;
      else process.env.RABBITMQ_URL = previousUrl;
    }
    expect(setup).toHaveBeenCalledTimes(2);
    expect(written).toHaveLength(2);
    expect(String(written[1]?.[0])).toContain('Topologia RabbitMQ declarada');
  });
});
