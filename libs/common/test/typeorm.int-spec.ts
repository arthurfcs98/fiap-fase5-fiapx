import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { StartedPostgres } from '@fiapx/testing';
import { startPostgres } from '@fiapx/testing';
import type { DatabaseConfig } from '../src';
import { createDataSource, runMigrations } from '../src';

@Entity({ name: 'probe' })
class ProbeOrmEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 50 })
  label!: string;
}

class CreateProbe1700000000000 implements MigrationInterface {
  name = 'CreateProbe1700000000000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query('CREATE TABLE probe (id uuid PRIMARY KEY, label varchar(50) NOT NULL)');
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE probe');
  }
}

class NotApplied1700000000001 implements MigrationInterface {
  name = 'NotApplied1700000000001';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query('CREATE TABLE never (id int)');
  }

  async down(): Promise<void> {
    // sem rollback
  }
}

/**
 * TypeORM 1.x + pg contra Postgres REAL (mesma imagem do compose): confirma que o schema só
 * nasce das migrações explícitas (synchronize desligado) e que o one-shot de migração é
 * idempotente.
 */
describe('createTypeOrmOptions/runMigrations com Postgres real', () => {
  let postgres: StartedPostgres;
  let config: DatabaseConfig;

  beforeAll(async () => {
    postgres = await startPostgres('fiapx_video');
    config = {
      DB_HOST: postgres.host,
      DB_PORT: postgres.port,
      DB_USER: postgres.user,
      DB_PASSWORD: postgres.password,
      DB_NAME: postgres.database,
      DB_SSL: false,
    };
  }, 180_000);

  afterAll(async () => {
    await postgres?.stop();
  });

  const input = { applicationName: 'video-api-int', entities: [ProbeOrmEntity] };

  it('sem migrações, a entidade NÃO vira tabela (synchronize: false)', async () => {
    const dataSource = createDataSource(config, { ...input, migrations: [] });
    await dataSource.initialize();
    try {
      const rows: unknown[] = await dataSource.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'probe'",
      );
      expect(rows).toHaveLength(0);
    } finally {
      await dataSource.destroy();
    }
  });

  it('runMigrations aplica a lista explícita uma vez e é idempotente', async () => {
    const migrations = [CreateProbe1700000000000];

    expect(await runMigrations(createDataSource(config, { ...input, migrations }))).toEqual([
      'CreateProbe1700000000000',
    ]);
    expect(await runMigrations(createDataSource(config, { ...input, migrations }))).toEqual([]);

    const dataSource = createDataSource(config, { ...input, migrations });
    await dataSource.initialize();
    try {
      const repository = dataSource.getRepository(ProbeOrmEntity);
      await repository.insert({ id: '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b', label: 'ok' });
      expect(await repository.count()).toBe(1);

      const [activity] = await dataSource.query<{ application_name: string }[]>(
        'SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()',
      );
      expect(activity?.application_name).toBe('video-api-int');
      expect(await dataSource.query("SELECT to_regclass('never') AS t")).toEqual([{ t: null }]);
    } finally {
      await dataSource.destroy();
    }
    // NotApplied só existe para provar que nada fora da lista roda.
    expect(NotApplied1700000000001.name).toBe('NotApplied1700000000001');
  });
});
