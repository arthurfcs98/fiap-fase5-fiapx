import { baseServiceConfigShape, envBoolean, portSchema } from '@fiapx/common';
import { metricsServerConfigShape } from '@fiapx/observability';
import { z } from 'zod';

export const SERVICE_NAME = 'video-api';

/** Token de injeção da configuração validada do video-api. */
export const API_CONFIG = Symbol('API_CONFIG');

export const apiConfigSchema = z.object({
  ...baseServiceConfigShape,
  ...metricsServerConfigShape,
  PORT: portSchema.default(3000),
  /** Swagger em /api/docs (desligável em produção, se necessário). */
  SWAGGER_ENABLED: envBoolean(true),
});

export type ApiConfig = z.output<typeof apiConfigSchema>;
