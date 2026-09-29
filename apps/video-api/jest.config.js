const path = require('node:path');
const { createJestProject } = require('../../jest.preset');

module.exports = {
  ...createJestProject({ name: 'video-api', rootDir: __dirname }),
  setupFiles: [path.join(__dirname, 'test', 'support', 'jest.setup.ts')],
};
