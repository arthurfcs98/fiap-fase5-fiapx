const path = require('node:path');
const { createJestProject } = require('../../../jest.preset');

const base = createJestProject({
  name: 'video-api-e2e',
  rootDir: path.join(__dirname, '..'),
  testRegex: '.*\\.e2e-spec\\.ts$',
});

// E2E exercises the HTTP behavior end to end against real containers (Testcontainers, images
// from compose.yaml); coverage is measured by the unit tests.
module.exports = {
  ...base,
  collectCoverageFrom: undefined,
  coverageThreshold: undefined,
  testTimeout: 240_000,
};
