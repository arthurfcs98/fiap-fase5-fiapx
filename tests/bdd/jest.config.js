/**
 * BDD E2E (`npm run test:bdd`): jest-cucumber against the RUNNING compose stack (make test-bdd
 * brings it up with 3 workers and a short zip retention). Features in pt-BR under
 * `tests/bdd/features`, steps in `tests/bdd/steps/*.steps.ts`. No coverage: it drives the real
 * containers over HTTP, AMQP, S3 and SQL.
 * @type {import('jest').Config}
 */
const path = require('node:path');
const { createJestProject } = require('../../jest.preset');

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { collectCoverageFrom, coverageThreshold, coverageDirectory, ...base } = createJestProject({
  name: 'bdd',
  rootDir: path.join(__dirname, '..', '..'),
  testRegex: 'tests/bdd/steps/.*\\.steps\\.ts$',
});

module.exports = {
  ...base,
  roots: ['<rootDir>/tests/bdd'],
  // Files run in name order: 99-logs-sem-dados-pessoais checks the logs of every other scenario.
  testSequencer: path.join(__dirname, 'support', 'name-order.sequencer.js'),
  testTimeout: 300_000,
  // Same parallelism as the rest of the suite would break the log/queue assertions.
  maxWorkers: 1,
};
