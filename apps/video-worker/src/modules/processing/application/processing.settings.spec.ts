import {
  FFPROBE_TIMEOUT_MS,
  MIN_STALE_WORK_DIR_MS,
  processingSettingsFromConfig,
} from './processing.settings';

const CONFIG = { FFMPEG_TIMEOUT_MS: 600_000, MAX_VIDEO_DURATION_S: 600 };

describe('processingSettingsFromConfig', () => {
  it('derives the pipeline settings from the config and the hostname', () => {
    expect(processingSettingsFromConfig(CONFIG, 'video-worker-7f9c')).toEqual({
      workerId: 'video-worker-7f9c',
      ffmpegTimeoutMs: 600_000,
      ffprobeTimeoutMs: FFPROBE_TIMEOUT_MS,
      maxVideoDurationS: 600,
      staleWorkDirMs: MIN_STALE_WORK_DIR_MS,
    });
  });

  it('keeps leftovers of long ffmpeg budgets for twice the budget', () => {
    const settings = processingSettingsFromConfig(
      { FFMPEG_TIMEOUT_MS: 3_600_000, MAX_VIDEO_DURATION_S: 600 },
      'w',
    );
    expect(settings.staleWorkDirMs).toBe(7_200_000);
  });

  it('never gives ffprobe more time than ffmpeg and keeps at least 1 h for the sweep', () => {
    const settings = processingSettingsFromConfig(
      { FFMPEG_TIMEOUT_MS: 5_000, MAX_VIDEO_DURATION_S: 10 },
      'w',
    );
    expect(settings.ffprobeTimeoutMs).toBe(5_000);
    expect(settings.staleWorkDirMs).toBe(MIN_STALE_WORK_DIR_MS);
  });

  it('caps the worker id at 100 characters and falls back when the hostname is empty', () => {
    expect(processingSettingsFromConfig(CONFIG, 'x'.repeat(150)).workerId).toHaveLength(100);
    expect(processingSettingsFromConfig(CONFIG, '  ').workerId).toBe('video-worker');
  });

  it('uses the machine hostname by default', () => {
    expect(processingSettingsFromConfig(CONFIG).workerId.length).toBeGreaterThan(0);
  });
});
