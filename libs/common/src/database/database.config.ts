import { z } from 'zod';
import { portSchema } from '../config/config.schemas';

/**
 * Variáveis do Postgres (contratos.md, seção 10): api e notification. `DB_PASSWORD` aceita
 * `DB_PASSWORD_FILE` (segredo por arquivo, via `loadConfig`).
 *
 * `DB_SSL` é OBRIGATÓRIA e sem padrão: cada ambiente declara se usa TLS (`false` no compose e no
 * Postgres do cluster; `true` para um banco gerenciado). Evita conectar sem TLS por esquecimento.
 */
export const databaseConfigShape = {
  DB_HOST: z.string().min(1),
  DB_PORT: portSchema.default(5432),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
  DB_SSL: z.stringbool({ error: 'DB_SSL é obrigatória: defina true ou false' }),
};

export const databaseConfigSchema = z.object(databaseConfigShape);
export type DatabaseConfig = z.output<typeof databaseConfigSchema>;
