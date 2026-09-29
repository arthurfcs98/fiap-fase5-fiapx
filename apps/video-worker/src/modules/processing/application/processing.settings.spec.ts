import {
  FFPROBE_TIMEOUT_MS,
  processingSettingsFromConfig,
  SHUTDOWN_TRANSFER_MARGIN_MS,
  shutdownTimeoutMsFor,
} from './processing.settings';

const CONFIG = { FFMPEG_TIMEOUT_MS: 600_000, MAX_VIDEO_DURATION_S: 600, MAX_FRAMES_MB: 1536 };

describe('processingSettingsFromConfig', () => {
  it('derives the pipeline settings from the config and the hostname', () => {
    expect(processingSettingsFromConfig(CONFIG, 'video-worker-7f9c')).toEqual({
      workerId: 'video-worker-7f9c',
      ffmpegTimeoutMs: 600_000,
      ffprobeTimeoutMs: FFPROBE_TIMEOUT_MS,
      maxVideoDurationS: 600,
      maxFramesBytes: 1536 * 1024 * 1024,
      staleWorkDirMs: 0,
      shutdownTimeoutMs: 690_000,
    });
  });

  it('never gives ffprobe more time than ffmpeg', () => {
    const settings = processingSettingsFromConfig(
      { FFMPEG_TIMEOUT_MS: 5_000, MAX_VIDEO_DURATION_S: 10, MAX_FRAMES_MB: 1 },
      'w',
    );
    expect(settings.ffprobeTimeoutMs).toBe(5_000);
    expect(settings.shutdownTimeoutMs).toBe(5_000 + 5_000 + SHUTDOWN_TRANSFER_MARGIN_MS);
  });

  it('caps the worker id at 100 characters and falls back when the hostname is empty', () => {
    expect(processingSettingsFromConfig(CONFIG, 'x'.repeat(150)).workerId).toHaveLength(100);
    expect(processingSettingsFromConfig(CONFIG, '  ').workerId).toBe('video-worker');
  });

  it('uses the machine hostname by default', () => {
    expect(processingSettingsFromConfig(CONFIG).workerId.length).toBeGreaterThan(0);
  });
});

describe('shutdownTimeoutMsFor', () => {
  it('covers ffprobe + ffmpeg at their budgets + the transfers (the whole job in progress)', () => {
    expect(shutdownTimeoutMsFor({ FFMPEG_TIMEOUT_MS: 600_000 })).toBe(
      FFPROBE_TIMEOUT_MS + 600_000 + SHUTDOWN_TRANSFER_MARGIN_MS,
    );
    // Grace periods of compose (stop_grace_period) and K8s must stay above it.
    expect(shutdownTimeoutMsFor({ FFMPEG_TIMEOUT_MS: 600_000 })).toBeLessThan(720_000);
  });
});
