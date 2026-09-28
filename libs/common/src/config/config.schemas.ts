import { z } from 'zod';

/** Blocos reutilizáveis para os schemas de configuração dos serviços. */
export const nodeEnvSchema = z.enum(['development', 'test', 'production']).default('development');

export const logLevelSchema = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  .default('info');

export const portSchema = z.coerce.number().int().min(1).max(65535);

/** Booleano vindo de env: aceita true/false, 1/0, yes/no, on/off. */
export const envBoolean = (defaultValue: boolean) => z.stringbool().default(defaultValue);

/** Lista separada por vírgula (`"a, b,,c"` → `["a","b","c"]`). */
export const csvList = z.string().transform((raw) =>
  raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

/** Campos comuns a todo serviço do FIAP X. */
export const baseServiceConfigShape = {
  NODE_ENV: nodeEnvSchema,
  LOG_LEVEL: logLevelSchema,
  /** Revisão de build da imagem (SHA do commit no CI); `dev` fora do CI. */
  APP_VERSION: z.string().min(1).default('dev'),
};
