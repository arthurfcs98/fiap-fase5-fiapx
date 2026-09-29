import { DataSource } from 'typeorm';
import type { DatabaseConfig } from './database.config';
import { createDataSource, createTypeOrmOptions, runMigrations } from './typeorm.config';

const config: DatabaseConfig = {
  DB_HOST: 'postgres',
  DB_PORT: 5432,
  DB_USER: 'fiapx_video',
  DB_PASSWORD: 'segredo',
  DB_NAME: 'fiapx_video',
  DB_SSL: false,
};

class Init1700000000000 {
  up(): Promise<void> {
    return Promise.resolve();
  }
  down(): Promise<void> {
    return Promise.resolve();
  }
}
class UserOrmEntity {}

describe('createTypeOrmOptions', () => {
  it('fixa synchronize/migrationsRun em false e usa as variáveis DB_*', () => {
    const options = createTypeOrmOptions(config, {
      applicationName: 'video-api',
      entities: [UserOrmEntity],
      migrations: [Init1700000000000],
    });

    expect(options).toEqual({
      type: 'postgres',
      host: 'postgres',
      port: 5432,
      username: 'fiapx_video',
      password: 'segredo',
      database: 'fiapx_video',
      ssl: false,
      applicationName: 'video-api',
      entities: [UserOrmEntity],
      migrations: [Init1700000000000],
      synchronize: false,
      migrationsRun: false,
      dropSchema: false,
      migrationsTransactionMode: 'each',
      poolSize: 10,
      connectTimeoutMS: 5_000,
      logging: false,
    });
  });

  it('DB_SSL=true liga TLS com verificação do certificado; pool e logging customizáveis', () => {
    const options = createTypeOrmOptions(
      { ...config, DB_SSL: true },
      {
        applicationName: 'x',
        entities: [],
        migrations: [],
        poolSize: 3,
        connectTimeoutMs: 1_000,
        logging: ['error'],
      },
    );
    expect(options).toMatchObject({
      ssl: { rejectUnauthorized: true },
      poolSize: 3,
      connectTimeoutMS: 1_000,
      logging: ['error'],
    });
  });
});

describe('createDataSource / runMigrations', () => {
  it('cria um DataSource não inicializado', () => {
    const dataSource = createDataSource(config, {
      applicationName: 'x',
      entities: [],
      migrations: [],
    });
    expect(dataSource).toBeInstanceOf(DataSource);
    expect(dataSource.isInitialized).toBe(false);
  });

  function fakeDataSource(initialized: boolean, run: () => Promise<{ name: string }[]>) {
    return {
      isInitialized: initialized,
      initialize: jest.fn(() => Promise.resolve()),
      runMigrations: jest.fn(run),
      destroy: jest.fn(() => Promise.resolve()),
    };
  }

  it('inicializa se preciso, roda cada migração na própria transação e fecha', async () => {
    const dataSource = fakeDataSource(false, () =>
      Promise.resolve([{ name: 'Init1700000000000' }]),
    );

    const applied = await runMigrations(dataSource as unknown as DataSource);

    expect(applied).toEqual(['Init1700000000000']);
    expect(dataSource.initialize).toHaveBeenCalled();
    expect(dataSource.runMigrations).toHaveBeenCalledWith({ transaction: 'each' });
    expect(dataSource.destroy).toHaveBeenCalled();
  });

  it('fecha a conexão mesmo quando a migração falha', async () => {
    const dataSource = fakeDataSource(true, () => Promise.reject(new Error('sql inválido')));

    await expect(runMigrations(dataSource as unknown as DataSource)).rejects.toThrow(
      'sql inválido',
    );
    expect(dataSource.initialize).not.toHaveBeenCalled();
    expect(dataSource.destroy).toHaveBeenCalled();
  });
});
