const path = require('node:path');
const { createJestProject } = require('../../../jest.preset');

const base = createJestProject({
  name: 'video-api-e2e',
  rootDir: path.join(__dirname, '..'),
  testRegex: '.*\\.e2e-spec\\.ts$',
});

// E2E valida comportamento HTTP de ponta a ponta; cobertura é medida nos testes unitários.
module.exports = { ...base, collectCoverageFrom: undefined, coverageThreshold: undefined };
