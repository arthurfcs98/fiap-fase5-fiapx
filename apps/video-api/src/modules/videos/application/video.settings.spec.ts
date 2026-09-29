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
          MAX_CONCURRENT_UPLOADS: '4',
          MAX_PENDING_VIDEOS_PER_USER: '6',
        }),
      ),
    ).toEqual({
      maxUploadMb: 2,
      maxUploadBytes: 2 * 1024 * 1024,
      publicBaseUrl: 'https://x.dev',
      downloadUrlTtlSeconds: 300,
      zipRetentionDays: 3,
      maxConcurrentUploads: 4,
      maxPendingVideosPerUser: 6,
    });
  });

  it('defaults: 8 uploads per replica, 5 videos in progress per user', () => {
    expect(videoSettingsFromConfig(testConfig())).toMatchObject({
      maxConcurrentUploads: 8,
      maxPendingVideosPerUser: 5,
    });
  });
});
