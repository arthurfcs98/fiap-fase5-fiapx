import { readFileSync } from 'node:fs';
import type { z } from 'zod';

/** Erro de configuração com a lista de problemas (sem valores, para não vazar segredos). */
export class ConfigValidationError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(
      `Configuração inválida (${issues.length} problema(s)):\n${issues.map((i) => `  - ${i}`).join('\n')}`,
    );
    this.name = 'ConfigValidationError';
  }
}

export interface LoadConfigOptions {
  /** Leitura de arquivo injetável (testes). Padrão: `fs.readFileSync(path, 'utf8')`. */
  readFile?: (path: string) => string;
}

/**
 * Carrega e valida a configuração a partir das variáveis de ambiente (fail fast).
 *
 * Regras:
 * - Valores vazios (`FOO=`) contam como ausentes, para o `default` do schema valer
 *   (o Compose interpola variáveis não definidas como string vazia).
 * - Segredos por arquivo: para cada chave `X` do schema, `X_FILE=/caminho` lê o valor do
 *   arquivo (sem espaços/quebra de linha nas pontas). Definir `X` e `X_FILE` juntos é erro.
 * - Qualquer problema lança {@link ConfigValidationError} listando TODAS as chaves inválidas.
 */
export function loadConfig<S extends z.ZodObject>(
  schema: S,
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): z.output<S> {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const issues: string[] = [];
  const input: Record<string, string> = {};

  for (const key of Object.keys(schema.shape)) {
    const direct = nonEmpty(env[key]);
    const filePath = nonEmpty(env[`${key}_FILE`]);

    if (direct !== undefined && filePath !== undefined) {
      issues.push(`${key}: defina ${key} ou ${key}_FILE, não os dois`);
      continue;
    }
    if (filePath !== undefined) {
      try {
        input[key] = readFile(filePath).trim();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        issues.push(`${key}_FILE: não foi possível ler "${filePath}" (${reason})`);
      }
      continue;
    }
    if (direct !== undefined) input[key] = direct;
  }

  if (issues.length > 0) throw new ConfigValidationError(issues);

  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((issue) => {
        const path = issue.path.map(String).join('.') || '(raiz)';
        return `${path}: ${issue.message}`;
      }),
    );
  }
  return result.data;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
