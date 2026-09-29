/**
 * Webpack of the video-api (Nest CLI, `nest build video-api`). On top of the CLI defaults:
 * - two entries: `main.js` (API) and `migrate.js` (one-shot migrations, K8s Job/compose);
 * - copies `apps/video-api/public` (static frontend) to `dist/apps/video-api/public`, the folder
 *   the Dockerfile ships next to the bundle.
 */
const fs = require('node:fs');
const path = require('node:path');

const APP_DIR = __dirname;
const OUTPUT_PREFIX = path.join('apps', 'video-api');

class CopyPublicDirPlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tap('CopyPublicDirPlugin', () => {
      const source = path.join(APP_DIR, 'public');
      const target = path.join(compiler.options.output.path, OUTPUT_PREFIX, 'public');
      fs.rmSync(target, { recursive: true, force: true });
      if (fs.existsSync(source)) fs.cpSync(source, target, { recursive: true });
    });
  }
}

module.exports = (options) => ({
  ...options,
  entry: {
    main: options.entry,
    migrate: path.join(APP_DIR, 'src', 'migrate.ts'),
  },
  output: {
    ...options.output,
    filename: path.join(OUTPUT_PREFIX, '[name].js'),
  },
  plugins: [...options.plugins, new CopyPublicDirPlugin()],
});
