import { baseServiceConfigShape } from '@fiapx/common';
import { metricsServerConfigShape } from '@fiapx/observability';
import { z } from 'zod';

export const SERVICE_NAME = 'video-worker';

/** Token de injeção da configuração validada do video-worker. */
export const WORKER_CONFIG = Symbol('WORKER_CONFIG');

export const workerConfigSchema = z.object({
  ...baseServiceConfigShape,
  ...metricsServerConfigShape,
});

export type WorkerConfig = z.output<typeof workerConfigSchema>;
