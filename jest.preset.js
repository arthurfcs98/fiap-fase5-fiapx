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

/** Aliases `@fiapx/<lib>` → `libs/<lib>/src` (espelho do `paths` do tsconfig.json). */
const moduleNameMapper = Object.fromEntries(
  LIBS.flatMap((lib) => [
    [`^@fiapx/${lib}$`, path.join(ROOT, 'libs', lib, 'src')],
    [`^@fiapx/${lib}/(.*)$`, path.join(ROOT, 'libs', lib, 'src', '$1')],
  ]),
);

const COVERAGE_THRESHOLD = { branches: 80, functions: 80, lines: 80, statements: 80 };

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
    },
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

module.exports = { createJestProject, moduleNameMapper, ROOT };
