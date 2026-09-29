/**
 * `npm run test:int`: testes de INTEGRAÇÃO (`<app|lib>/test/**\/*.int-spec.ts`) com dependências
 * reais em containers descartáveis (Testcontainers + Docker). Um project por app/lib; basta criar
 * o arquivo `*.int-spec.ts` na pasta `test/` do app/lib (sem mexer aqui).
 *
 * Roda em série (`--runInBand` no script): cada arquivo sobe os próprios containers.
 * @type {import('jest').Config}
 */
const path = require('node:path');
const { createIntegrationProject } = require('./jest.preset');

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
  projects: PROJECTS.map((project) =>
    createIntegrationProject({
      name: path.basename(project),
      rootDir: path.join(__dirname, project),
    }),
  ),
};
