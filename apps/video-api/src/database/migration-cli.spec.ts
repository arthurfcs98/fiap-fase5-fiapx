import { DataSource } from 'typeorm';
import { runMigrationCli } from './migration-cli';

const env = {
  DB_HOST: 'postgres',
  DB_USER: 'fiapx_video',
  DB_PASSWORD: 'x',
  DB_NAME: 'fiapx_video',
  DB_SSL: 'false',
  APP_VERSION: 'sha-abc1234',
};

describe('runMigrationCli', () => {
  it('runs the explicit migrations with only the DB variables and logs a JSON line', async () => {
    const lines: string[] = [];
    const run = jest.fn((dataSource: DataSource) => {
      expect(dataSource).toBeInstanceOf(DataSource);
      expect(dataSource.options).toMatchObject({
        applicationName: 'video-api-migrate',
        synchronize: false,
        migrationsRun: false,
      });
      return Promise.resolve(['Init1790553600000']);
    });

    await expect(runMigrationCli({ env, run, write: (line) => lines.push(line) })).resolves.toEqual(
      ['Init1790553600000'],
    );

    expect(JSON.parse(lines[0])).toMatchObject({
      level: 'info',
      service: 'video-api',
      version: 'sha-abc1234',
      msg: 'Migrações aplicadas',
      database: 'fiapx_video',
      applied: ['Init1790553600000'],
    });
  });

  it('reports when nothing is pending', async () => {
    const lines: string[] = [];
    await runMigrationCli({ env, run: () => Promise.resolve([]), write: (l) => lines.push(l) });
    expect(JSON.parse(lines[0])).toMatchObject({ msg: 'Nenhuma migração pendente' });
  });

  it('fails fast without the DB variables', async () => {
    await expect(runMigrationCli({ env: {}, run: jest.fn() })).rejects.toThrow(/DB_HOST/);
  });

  it('writes to stdout by default', async () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runMigrationCli({ env, run: () => Promise.resolve([]) });
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"service":"video-api"'));
  });
});
