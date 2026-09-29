import { baseServiceConfigShape, loadConfig } from '@fiapx/common';
import { z } from 'zod';
import { messagingConfigShape } from './messaging.config';
import type { Topology } from './topology';
import type { SetupTopologyOptions } from './topology-setup';
import { setupTopology } from './topology-setup';

/** Only the broker: the one-shot must not require database, storage or JWT variables. */
export const topologyCliConfigSchema = z.object({
  ...baseServiceConfigShape,
  ...messagingConfigShape,
});

/** How long the one-shot waits for the broker to accept connections (default). */
export const TOPOLOGY_CLI_TIMEOUT_MS = 120_000;
/** Pause between two connection attempts (default). */
export const TOPOLOGY_CLI_RETRY_DELAY_MS = 2_000;

/**
 * Broker answers that no retry fixes: a queue declared with other arguments
 * (PRECONDITION_FAILED), a user without permission (ACCESS_REFUSED, also a wrong password in
 * the handshake) or an operation the broker forbids.
 */
const PERMANENT_FAILURE = /PRECONDITION[-_]FAILED|ACCESS[-_]REFUSED|NOT[-_]ALLOWED/i;

export interface TopologyCliDependencies {
  /** Service name written in the log line (e.g. `video-api`). */
  service: string;
  env?: NodeJS.ProcessEnv;
  setup?: (options: SetupTopologyOptions) => Promise<Topology>;
  write?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  retryDelayMs?: number;
}

/**
 * One-shot topology declaration (`node dist/setup-topology.js` in the video-api image): first
 * container of the K8s Job `rabbitmq-init`, with the ADMINISTRATOR's `RABBITMQ_URL`, before the
 * rollout of the services (contratos.md, section 2).
 *
 * Why a one-shot and not only the services: in K8s each service has its own RabbitMQ user with
 * the minimum permissions, and RabbitMQ only lets a user CREATE a queue with a dead-letter
 * exchange when it has `read` on that queue and `write` on the exchange (`fiapx.dlx`), which no
 * service has. The services keep declaring the topology at every (re)connection, which for
 * queues that already exist needs only `configure`. The topology itself stays in code
 * (`buildTopology()`): this is the same declaration, run by the administrator.
 *
 * Retries while the broker does not answer (it may still be booting) until `timeoutMs`; a
 * permanent answer (divergent arguments, permission) fails at once. Writes one JSON line per
 * event (same shape as the pino logs) and never the URL (it carries the password).
 */
export async function runTopologySetupCli(deps: TopologyCliDependencies): Promise<Topology> {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const setup = deps.setup ?? setupTopology;
  const timeoutMs = deps.timeoutMs ?? TOPOLOGY_CLI_TIMEOUT_MS;
  const retryDelayMs = deps.retryDelayMs ?? TOPOLOGY_CLI_RETRY_DELAY_MS;
  const config = loadConfig(topologyCliConfigSchema, deps.env ?? process.env);
  const log = (level: 'info' | 'warn', msg: string, extra: Record<string, unknown>) =>
    write(
      JSON.stringify({
        level,
        time: new Date(now()).toISOString(),
        service: deps.service,
        version: config.APP_VERSION,
        msg,
        ...extra,
      }),
    );

  const deadline = now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      const topology = await setup({
        url: config.RABBITMQ_URL,
        connectionName: `${deps.service}-setup-topology`,
      });
      log('info', 'Topologia RabbitMQ declarada', {
        exchanges: topology.exchanges.length,
        queues: topology.queues.length,
        bindings: topology.bindings.length,
        attempts: attempt,
      });
      return topology;
    } catch (error) {
      if (isPermanentFailure(error) || now() + retryDelayMs > deadline) throw error;
      log('warn', `RabbitMQ indisponível; nova tentativa em ${retryDelayMs} ms`, {
        attempt,
        error: errorName(error),
      });
      await sleep(retryDelayMs);
    }
  }
}

function isPermanentFailure(error: unknown): boolean {
  return error instanceof Error && PERMANENT_FAILURE.test(error.message);
}

/** Code or class of the error only: amqplib messages may echo connection details. */
function errorName(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : error.name;
  }
  return typeof error;
}
