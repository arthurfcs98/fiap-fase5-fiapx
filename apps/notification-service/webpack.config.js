/**
 * Webpack config of the notification-service (Nest CLI, `webpackConfigPath` in nest-cli.json).
 * Adds a second entry to the default one: `dist/apps/notification-service/migrate.js`, the
 * `migrate` one-shot (compose `notification-migrate` / K8s Job: `node dist/migrate.js`), built
 * from the same sources and externals as `main.js`.
 */
const path = require('node:path');

module.exports = (options) => ({
  ...options,
  entry: {
    main: options.entry,
    migrate: path.join(__dirname, 'src', 'migrate.ts'),
  },
  output: {
    ...options.output,
    filename: path.join(path.dirname(options.output.filename), '[name].js'),
  },
});
