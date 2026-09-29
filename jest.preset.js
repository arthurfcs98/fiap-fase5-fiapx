/**
 * Fábrica de configuração Jest compartilhada por todos os projects (apps e libs).
 *
 * Cada app/lib tem o próprio `jest.config.js`, que chama `createJestProject`.
 * - `npm test` roda todos via `jest.config.js` da raiz (`projects`).
 * - `npm run test:cov` roda cada project SEPARADAMENTE (scripts/test-cov.mjs), porque o
 *   `coverageThreshold` do Jest é global e é ignorado dentro de `projects`. Rodando um
 *   project por vez, o threshold de 80% vale para aquele app/lib isoladamente.
 */
const path = require('node:path');

const ROOT = __dirname;
const LIBS = ['common', 'observability', 'messaging', 'contracts', 'storage'];

/**
 * Aliases `@fiapx/<lib>` → `libs/<lib>/src` e `@fiapx/testing` → `test/support` (suporte dos
 * testes de integração). Espelho do `paths` do tsconfig.json.
 */
const moduleNameMapper = {
  ...Object.fromEntries(
    LIBS.flatMap((lib) => [
      [`^@fiapx/${lib}$`, path.join(ROOT, 'libs', lib, 'src')],
      [`^@fiapx/${lib}/(.*)$`, path.join(ROOT, 'libs', lib, 'src', '$1')],
    ]),
  ),
  '^@fiapx/testing$': path.join(ROOT, 'test', 'support'),
};

const COVERAGE_THRESHOLD = { branches: 80, functions: 80, lines: 80, statements: 80 };

/**
 * Pacotes publicados só como ESM (o Jest roda em CommonJS e o Node 22 não faz `require` de
 * ESM dentro do Jest). São convertidos por `scripts/jest/esm-to-cjs.transformer.js`; o resto de
 * `node_modules` continua sem transformação. Novo pacote ESM-only usado em código testado →
 * incluir aqui (ele e as dependências ESM dele: `npm ls --all <pacote>`).
 */
const ESM_ONLY_PACKAGES = [
  'file-type',
  'strtok3',
  'token-types',
  'uint8array-extras',
  '@tokenizer/inflate',
  '@borewit/text-codec',
];
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const transformIgnorePatterns = [
  `/node_modules/(?!(${ESM_ONLY_PACKAGES.map(escapeRegex).join('|')})/)`,
];

/**
 * @param {{ name: string, rootDir: string, testRegex?: string }} options
 * @returns {import('jest').Config}
 */
function createJestProject({ name, rootDir, testRegex = '.*\\.spec\\.ts$' }) {
  return {
    displayName: name,
    rootDir,
    testEnvironment: 'node',
    moduleFileExtensions: ['ts', 'js', 'json'],
    testRegex,
    transform: {
      // diagnostics: false → os testes NÃO checam tipos. O ts-jest compila com o language
      // service em CommonJS + resolução node10 (ele força isso mesmo que o tsconfig peça
      // node16/nodenext), enquanto build e typecheck usam nodenext com `exports`. Checar tipos
      // nos dois modos faria um pacote com tipos só em `exports` passar num e falhar no outro.
      // A checagem de tipos (specs inclusive) fica só no `npm run typecheck`, no modo do build.
      // O language service continua sendo usado para emitir o decorator metadata com os tipos
      // reais (sem os ternários `typeof X === "function"` do modo isolado, que distorcem a
      // cobertura de branches).
      '^.+\\.ts$': [
        'ts-jest',
        { tsconfig: path.join(ROOT, 'tsconfig.spec.json'), diagnostics: false },
      ],
      '^.+\\.m?js$': path.join(ROOT, 'scripts', 'jest', 'esm-to-cjs.transformer.js'),
    },
    transformIgnorePatterns,
    moduleNameMapper,
    // Exclusões mínimas: só bootstrap (main.ts), wiring de módulo Nest e barrels.
    collectCoverageFrom: [
      'src/**/*.ts',
      '!src/main.ts',
      '!src/**/*.module.ts',
      '!src/**/index.ts',
      '!src/**/*.spec.ts',
    ],
    coverageDirectory: path.join(ROOT, 'coverage', name),
    coverageReporters: ['text', 'text-summary', 'lcov', 'json-summary'],
    coverageThreshold: { global: COVERAGE_THRESHOLD },
    clearMocks: true,
    restoreMocks: true,
  };
}

/**
 * Project de testes de INTEGRAÇÃO (`*.int-spec.ts`, fora de `src/`): dependências reais
 * (RabbitMQ, Postgres, Garage) via Testcontainers. Sem cobertura (medida nos unitários) e com
 * timeout longo (subida de containers). Rodar com `npm run test:int` (jest.int.config.js).
 *
 * @param {{ name: string, rootDir: string }} options
 * @returns {import('jest').Config}
 */
function createIntegrationProject({ name, rootDir }) {
  // Opções de cobertura só valem na configuração raiz: ficam de fora do project de integração.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { collectCoverageFrom, coverageThreshold, coverageReporters, coverageDirectory, ...base } =
    createJestProject({ name: `${name}-int`, rootDir, testRegex: '.*\\.int-spec\\.ts$' });
  return { ...base, testTimeout: 180_000 };
}

module.exports = {
  createIntegrationProject,
  createJestProject,
  ESM_ONLY_PACKAGES,
  moduleNameMapper,
  ROOT,
};
