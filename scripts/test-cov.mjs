#!/usr/bin/env node
/**
 * Roda a cobertura de cada project (app/lib) SEPARADAMENTE, para que o threshold de 80%
 * (branches/functions/lines/statements) valha para cada um isoladamente.
 *
 * Uso:
 *   npm run test:cov                                   # todos os projects
 *   npm run test:cov -- apps/video-api                 # só um (usado pela matrix do CI)
 *   npm run test:cov -- libs/common --runInBand        # flags (começam com -) vão para o Jest
 *
 * Flag com valor vai no formato `--flag=valor` (ex.: `--testNamePattern=config`): argumentos
 * sem `-` são sempre interpretados como project.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const jestBin = require.resolve('jest/bin/jest');

const ALL_PROJECTS = [
  'apps/video-api',
  'apps/video-worker',
  'apps/notification-service',
  'libs/common',
  'libs/observability',
  'libs/messaging',
  'libs/contracts',
  'libs/storage',
];

const args = process.argv.slice(2);
const requested = args.filter((arg) => !arg.startsWith('-'));
/** Flags extras repassadas a cada execução do Jest (ex.: --runInBand, --silent). */
const jestFlags = args.filter((arg) => arg.startsWith('-'));
const unknown = requested.filter((p) => !ALL_PROJECTS.includes(p));
if (unknown.length > 0) {
  console.error(`Project(s) desconhecido(s): ${unknown.join(', ')}`);
  console.error(`Válidos: ${ALL_PROJECTS.join(', ')}`);
  process.exit(2);
}
const projects = requested.length > 0 ? requested : ALL_PROJECTS;

const results = [];
for (const project of projects) {
  const name = path.basename(project);
  const summaryFile = path.join(ROOT, 'coverage', name, 'coverage-summary.json');
  // Sem isto, um resumo de uma execução anterior apareceria na tabela quando o Jest falha
  // antes de gravar o novo.
  rmSync(summaryFile, { force: true });
  console.log(`\n=== Cobertura: ${project} ===`);
  const run = spawnSync(
    process.execPath,
    [jestBin, '-c', path.join(project, 'jest.config.js'), '--coverage', '--ci', ...jestFlags],
    { cwd: ROOT, stdio: 'inherit' },
  );
  const total = existsSync(summaryFile)
    ? JSON.parse(readFileSync(summaryFile, 'utf8')).total
    : undefined;
  results.push({ project, ok: run.status === 0, total });
}

const pct = (metric) => (metric ? `${metric.pct.toFixed(2)}%` : 'n/a');
console.log('\nResumo da cobertura (threshold 80% por project):');
console.table(
  results.map(({ project, ok, total }) => ({
    project,
    status: ok ? 'OK' : 'FALHOU',
    statements: pct(total?.statements),
    branches: pct(total?.branches),
    functions: pct(total?.functions),
    lines: pct(total?.lines),
  })),
);

// No GitHub Actions, a tabela também vai para o resumo do job.
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    '### Cobertura (threshold 80% por project)',
    '',
    '| Project | Status | Statements | Branches | Functions | Lines |',
    '|---|---|---|---|---|---|',
    ...results.map(
      ({ project, ok, total }) =>
        `| ${project} | ${ok ? '✅' : '❌'} | ${pct(total?.statements)} | ${pct(total?.branches)} | ${pct(total?.functions)} | ${pct(total?.lines)} |`,
    ),
    '',
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(
    `\n${failed.length} project(s) falharam: ${failed.map((f) => f.project).join(', ')}`,
  );
  process.exit(1);
}
