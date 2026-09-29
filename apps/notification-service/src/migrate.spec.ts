jest.mock('./database/migrate.command', () => ({ runMigrateCommand: jest.fn() }));

describe('migrate entry (dist/migrate.js)', () => {
  const previousExitCode = process.exitCode;

  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  it.each([0, 1])('runs the migrate command and exits with its code (%p)', async (code) => {
    await jest.isolateModulesAsync(async () => {
      // Same (isolated) registry as the entry loaded below, so this is the mock it calls.
      const { runMigrateCommand } = jest.requireMock<{
        runMigrateCommand: jest.Mock<Promise<number>>;
      }>('./database/migrate.command');
      runMigrateCommand.mockResolvedValue(code);

      const entry = jest.requireActual<{ migration: Promise<void> }>('./migrate');
      await entry.migration;

      expect(runMigrateCommand).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(code);
    });
  });
});
