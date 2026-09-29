import { z } from 'zod';

/**
 * Variável do broker (contratos.md, seção 10), para compor o schema de config de cada app:
 * `z.object({ ...baseServiceConfigShape, ...messagingConfigShape })`. Aceita
 * `RABBITMQ_URL_FILE` (segredo por arquivo, via `loadConfig`).
 */
export const messagingConfigShape = {
  RABBITMQ_URL: z
    .string()
    .regex(/^amqps?:\/\/[^/\s]+/, 'RABBITMQ_URL deve ser uma URL amqp:// ou amqps://'),
};
