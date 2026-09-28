/**
 * `npm test`: roda todos os projects juntos (sem cobertura).
 * Cobertura com threshold por project: `npm run test:cov` (ver jest.preset.js).
 * @type {import('jest').Config}
 */
module.exports = {
  projects: [
    '<rootDir>/apps/video-api',
    '<rootDir>/apps/video-worker',
    '<rootDir>/apps/notification-service',
    '<rootDir>/libs/common',
    '<rootDir>/libs/observability',
    '<rootDir>/libs/messaging',
    '<rootDir>/libs/contracts',
    '<rootDir>/libs/storage',
  ],
};
