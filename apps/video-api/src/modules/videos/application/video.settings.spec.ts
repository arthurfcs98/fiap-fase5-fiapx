import { testConfig } from '../../../../test/support/config';
import { videoSettingsFromConfig } from './video.settings';

describe('videoSettingsFromConfig', () => {
  it('derives the upload limit in bytes and keeps the 5 min download link', () => {
    expect(
      videoSettingsFromConfig(
        testConfig({
          MAX_UPLOAD_MB: '2',
          PUBLIC_BASE_URL: 'https://x.dev',
          ZIP_RETENTION_DAYS: '3',
        }),
      ),
    ).toEqual({
      maxUploadMb: 2,
      maxUploadBytes: 2 * 1024 * 1024,
      publicBaseUrl: 'https://x.dev',
      downloadUrlTtlSeconds: 300,
      zipRetentionDays: 3,
    });
  });
});
