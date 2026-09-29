import type { VideoProbe } from './video-probe';
import { evaluateProbe } from './video-probe';

const MP4: VideoProbe = {
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationSeconds: 3,
  videoStreamCount: 1,
};

describe('evaluateProbe', () => {
  it.each([
    ['mp4/mov', 'mov,mp4,m4a,3gp,3g2,mj2'],
    ['mkv/webm', 'matroska,webm'],
    ['avi', 'avi'],
    ['wmv', 'asf'],
    ['flv', 'flv'],
  ])('accepts the upload containers (%s)', (_case, formatName) => {
    expect(evaluateProbe({ ...MP4, formatName }, 600)).toEqual({ accepted: true });
  });

  it.each([
    ['HLS playlist', 'hls'],
    ['image', 'png_pipe'],
    ['empty format name', ''],
  ])('refuses other formats as invalid (%s)', (_case, formatName) => {
    expect(evaluateProbe({ ...MP4, formatName }, 600)).toEqual({
      accepted: false,
      reason: 'invalid',
      detail: `unsupported container format: ${formatName || 'unknown'}`,
    });
  });

  it('refuses files without a video stream (audio only)', () => {
    expect(evaluateProbe({ ...MP4, videoStreamCount: 0 }, 600)).toEqual({
      accepted: false,
      reason: 'invalid',
      detail: 'no video stream',
    });
  });

  it('refuses videos longer than the limit', () => {
    expect(evaluateProbe({ ...MP4, durationSeconds: 600.5 }, 600)).toEqual({
      accepted: false,
      reason: 'too_long',
      durationSeconds: 600.5,
      maxDurationSeconds: 600,
    });
  });

  it('accepts exactly the limit and unknown durations (ffmpeg timeout still bounds them)', () => {
    expect(evaluateProbe({ ...MP4, durationSeconds: 600 }, 600).accepted).toBe(true);
    expect(evaluateProbe({ ...MP4, durationSeconds: undefined }, 600).accepted).toBe(true);
  });
});
