/**
 * `npm test`: roda todos os projects juntos (sem cobertura).
 * Cobertura com threshold por project: `npm run test:cov` (ver jest.preset.js).
 *
 * `coverageThreshold`/`coverageReporters` só valem na configuração raiz: são removidos daqui
 * (evita os "Validation Warning" do Jest); o `test:cov` usa o `jest.config.js` de cada project.
 * @type {import('jest').Config}
 */
const path = require('node:path');

const PROJECTS = [
  'apps/video-api',
  'apps/video-worker',
  'apps/notification-service',
  'libs/common',
  'libs/observability',
  'libs/messaging',
  'libs/contracts',
  'libs/storage',
];

module.exports = {
  projects: PROJECTS.map((project) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { coverageThreshold, coverageReporters, ...config } = require(
      path.join(__dirname, project, 'jest.config.js'),
    );
    return config;
  }),
};
