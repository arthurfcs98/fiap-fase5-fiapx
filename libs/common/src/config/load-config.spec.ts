import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { baseServiceConfigShape, portSchema } from './config.schemas';
import { ConfigValidationError, loadConfig } from './load-config';

const schema = z.object({
  ...baseServiceConfigShape,
  PORT: portSchema.default(3000),
  DB_PASSWORD: z.string().min(8),
});

describe('loadConfig', () => {
  it('aplica defaults e converte tipos', () => {
    const config = loadConfig(schema, { DB_PASSWORD: 'super-secreta', PORT: '8080' });

    expect(config).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      APP_VERSION: 'dev',
      PORT: 8080,
      DB_PASSWORD: 'super-secreta',
    });
  });

  it('trata valores vazios como ausentes (default do schema vale)', () => {
    const config = loadConfig(schema, { DB_PASSWORD: 'super-secreta', APP_VERSION: '', PORT: '' });
    expect(config.APP_VERSION).toBe('dev');
    expect(config.PORT).toBe(3000);
  });

  it('ignora variáveis que não estão no schema', () => {
    const config = loadConfig(schema, { DB_PASSWORD: 'super-secreta', HOME: '/root' });
    expect(config).not.toHaveProperty('HOME');
  });

  it('lista TODOS os problemas, sem expor valores', () => {
    let error: unknown;
    try {
      loadConfig(schema, { PORT: '99999', LOG_LEVEL: 'verbose', DB_PASSWORD: 'curta' });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ConfigValidationError);
    const { issues, message } = error as ConfigValidationError;
    expect(issues).toHaveLength(3);
    expect(issues.map((i) => i.split(':')[0]).sort()).toEqual(['DB_PASSWORD', 'LOG_LEVEL', 'PORT']);
    expect(message).toMatch(/^Configuração inválida \(3 problema\(s\)\):\n {2}- /);
    expect(message).not.toContain('curta');
  });

  it('usa process.env por padrão', () => {
    const previous = process.env['DB_PASSWORD'];
    process.env['DB_PASSWORD'] = 'do-process-env';
    try {
      expect(loadConfig(schema).DB_PASSWORD).toBe('do-process-env');
    } finally {
      if (previous === undefined) delete process.env['DB_PASSWORD'];
      else process.env['DB_PASSWORD'] = previous;
    }
  });

  describe('segredos por arquivo (<CHAVE>_FILE)', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'fiapx-config-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('lê o valor do arquivo e remove espaços/quebras de linha', () => {
      const file = path.join(dir, 'db_password');
      writeFileSync(file, '  segredo-do-arquivo\n');

      const config = loadConfig(schema, { DB_PASSWORD_FILE: file });

      expect(config.DB_PASSWORD).toBe('segredo-do-arquivo');
    });

    it('falha quando o arquivo não pode ser lido', () => {
      expect(() => loadConfig(schema, { DB_PASSWORD_FILE: path.join(dir, 'nao-existe') })).toThrow(
        /DB_PASSWORD_FILE: não foi possível ler/,
      );
    });

    it('falha quando a chave e a versão _FILE são definidas juntas', () => {
      expect(() =>
        loadConfig(schema, { DB_PASSWORD: 'abcdefghij', DB_PASSWORD_FILE: '/run/secrets/x' }),
      ).toThrow(/defina DB_PASSWORD ou DB_PASSWORD_FILE, não os dois/);
    });

    it('aceita leitor de arquivo injetado e reporta erros não-Error', () => {
      const readFile = jest.fn((): string => {
        throw 'EACCES'; // eslint-disable-line @typescript-eslint/only-throw-error
      });
      expect(() => loadConfig(schema, { DB_PASSWORD_FILE: '/x' }, { readFile })).toThrow(
        /\(EACCES\)/,
      );
    });
  });

  it('reporta erro de schema na raiz com "(raiz)"', () => {
    const refined = z
      .object({ A: z.string().optional(), B: z.string().optional() })
      .refine((c) => c.A !== undefined || c.B !== undefined, { message: 'defina A ou B' });
    expect(() => loadConfig(refined as unknown as z.ZodObject, {})).toThrow(
      /\(raiz\): defina A ou B/,
    );
  });
});
