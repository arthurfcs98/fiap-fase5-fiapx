const { createJestProject } = require('../../jest.preset');

module.exports = createJestProject({ name: 'contracts', rootDir: __dirname });
