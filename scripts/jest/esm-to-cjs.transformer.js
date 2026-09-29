/**
 * Transformer Jest mínimo: converte para CommonJS os pacotes de `node_modules` publicados só
 * como ESM (ex.: `file-type` e dependências). O Jest roda os testes em CommonJS e, no Node 22
 * (CI e imagens), não carrega ESM via `require`. Build e runtime não passam por aqui: o
 * webpack do Nest empacota ESM normalmente.
 *
 * A lista de pacotes transformados fica em `ESM_ONLY_PACKAGES` (jest.preset.js).
 */
const { createHash } = require('node:crypto');
const ts = require('typescript');

const COMPILER_OPTIONS = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2023,
  allowJs: true,
  esModuleInterop: true,
  sourceMap: false,
};

module.exports = {
  process(sourceText, sourcePath) {
    const { outputText } = ts.transpileModule(sourceText, {
      compilerOptions: COMPILER_OPTIONS,
      fileName: sourcePath,
    });
    return { code: outputText };
  },
  getCacheKey(sourceText, sourcePath) {
    return createHash('sha256')
      .update(ts.version)
      .update('\0')
      .update(sourcePath)
      .update('\0')
      .update(sourceText)
      .digest('hex');
  },
};
