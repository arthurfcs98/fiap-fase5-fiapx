import { z } from 'zod';

/** Variáveis do servidor interno de health/métricas (worker e notification). */
export const metricsServerConfigShape = {
  /** 0 = porta efêmera (só em testes). */
  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
  METRICS_HOST: z.string().min(1).default('0.0.0.0'),
  /** Se definido, `/metrics` exige `Authorization: Bearer <token>`. `/health` é sempre aberto. */
  METRICS_TOKEN: z.string().min(16, 'METRICS_TOKEN precisa de pelo menos 16 caracteres').optional(),
};
