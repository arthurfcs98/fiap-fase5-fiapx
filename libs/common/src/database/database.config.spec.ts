import { z } from 'zod';
import { loadConfig } from '../config/load-config';
import { databaseConfigShape } from './database.config';

const schema = z.object(databaseConfigShape);
const env = {
  DB_HOST: 'postgres',
  DB_USER: 'fiapx_video',
  DB_PASSWORD: 'segredo-de-teste',
  DB_NAME: 'fiapx_video',
  DB_SSL: 'false',
};

describe('databaseConfigShape', () => {
  it('lê as variáveis DB_* com porta padrão 5432', () => {
    expect(loadConfig(schema, env)).toEqual({ ...env, DB_PORT: 5432, DB_SSL: false });
  });

  it('DB_SSL é obrigatória (sem padrão) e aceita true', () => {
    const { DB_SSL: _omitted, ...withoutSsl } = env;
    expect(() => loadConfig(schema, withoutSsl)).toThrow('DB_SSL');
    expect(loadConfig(schema, { ...env, DB_SSL: 'true', DB_PORT: '6543' })).toMatchObject({
      DB_SSL: true,
      DB_PORT: 6543,
    });
  });

  it('senha por arquivo (DB_PASSWORD_FILE)', () => {
    const { DB_PASSWORD: _omitted, ...rest } = env;
    const config = loadConfig(
      schema,
      { ...rest, DB_PASSWORD_FILE: '/run/secrets/db' },
      { readFile: () => 'do-arquivo\n' },
    );
    expect(config.DB_PASSWORD).toBe('do-arquivo');
  });
});
