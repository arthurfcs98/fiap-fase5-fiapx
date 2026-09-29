import type { DataSourceOptions, LoggerOptions } from 'typeorm';
import { DataSource } from 'typeorm';
import type { DatabaseConfig } from './database.config';

type PostgresOptions = Extract<DataSourceOptions, { type: 'postgres' }>;

export interface TypeOrmOptionsInput {
  /** Nome do serviço: vira o `application_name` (aparece em `pg_stat_activity`). */
  applicationName: string;
  /** Entidades ORM (classes da camada `infrastructure`). */
  entities: NonNullable<PostgresOptions['entities']>;
  /**
   * Lista EXPLÍCITA das classes de migração (sem glob: o bundle do webpack não carrega arquivos
   * por padrão de caminho, e a ordem fica visível no código).
   */
  migrations: NonNullable<PostgresOptions['migrations']>;
  /** Conexões no pool. Padrão: 10. */
  poolSize?: number;
  /** Timeout para abrir conexão. Padrão: 5000 ms. */
  connectTimeoutMs?: number;
  /** Padrão: `false` (o logger do TypeORM não usa o pino; logue no repositório se precisar). */
  logging?: LoggerOptions;
}

/**
 * Opções TypeORM do FIAP X a partir das variáveis `DB_*` (contratos.md, seções 5, 6 e 10):
 * `synchronize: false` e `migrationsRun: false` FIXOS (o schema nasce só das migrações, rodadas
 * por um one-shot antes do deploy, ver {@link runMigrations}) e TLS explícito por `DB_SSL`.
 *
 * Uso: `TypeOrmModule.forRootAsync({ inject: [API_CONFIG], useFactory: (c) =>
 * createTypeOrmOptions(c, { applicationName: SERVICE_NAME, entities: [...], migrations: [...] }) })`.
 */
export function createTypeOrmOptions(
  config: DatabaseConfig,
  input: TypeOrmOptionsInput,
): PostgresOptions {
  const poolSize = input.poolSize ?? 10;
  return {
    type: 'postgres',
    host: config.DB_HOST,
    port: config.DB_PORT,
    username: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    ssl: config.DB_SSL ? { rejectUnauthorized: true } : false,
    applicationName: input.applicationName,
    entities: input.entities,
    migrations: input.migrations,
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
    migrationsTransactionMode: 'each',
    poolSize,
    connectTimeoutMS: input.connectTimeoutMs ?? 5_000,
    logging: input.logging ?? false,
  };
}

/** DataSource avulso (one-shot de migração, scripts, testes de integração). */
export function createDataSource(config: DatabaseConfig, input: TypeOrmOptionsInput): DataSource {
  return new DataSource(createTypeOrmOptions(config, input));
}

/**
 * Roda as migrações pendentes (cada uma na própria transação) e fecha a conexão. Para o
 * one-shot `migrate` (Job no K8s / serviço no compose). Devolve os nomes aplicados.
 */
export async function runMigrations(dataSource: DataSource): Promise<string[]> {
  if (!dataSource.isInitialized) await dataSource.initialize();
  try {
    const applied = await dataSource.runMigrations({ transaction: 'each' });
    return applied.map((migration) => migration.name);
  } finally {
    await dataSource.destroy();
  }
}
