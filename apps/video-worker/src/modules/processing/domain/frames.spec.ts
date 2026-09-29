import {
  FRAME_FILE_PATTERN,
  FRAME_OUTPUT_LIMITS,
  frameIndex,
  isFrameFileName,
  maxFramesFor,
  sortFrames,
} from './frames';

const frame = (name: string) => ({ name, path: `/work/v/frames/${name}` });

describe('frames', () => {
  it('uses the base project pattern', () => {
    expect(FRAME_FILE_PATTERN).toBe('frame_%04d.png');
  });

  it.each([
    ['frame_0001.png', true, 1],
    ['frame_9999.png', true, 9999],
    ['frame_10000.png', true, 10000],
    ['frame_001.png', false, undefined],
    ['frame_0001.jpg', false, undefined],
    ['source.mp4', false, undefined],
  ])('%s → frame file %p, index %p', (name, isFrame, index) => {
    expect(isFrameFileName(name)).toBe(isFrame);
    expect(frameIndex(name)).toBe(index);
  });

  it('keeps only frames, ordered numerically (not lexically)', () => {
    const sorted = sortFrames([
      frame('frame_10000.png'),
      frame('frame_0002.png'),
      frame('notes.txt'),
      frame('frame_9999.png'),
      frame('frame_0001.png'),
    ]);
    expect(sorted.map((f) => f.name)).toEqual([
      'frame_0001.png',
      'frame_0002.png',
      'frame_9999.png',
      'frame_10000.png',
    ]);
  });

  it('bounds the output: one frame per second of the longest video, 1920 px at most', () => {
    expect(maxFramesFor(600)).toBe(600);
    expect(maxFramesFor(600.4)).toBe(600);
    expect(maxFramesFor(0.2)).toBe(1);
    expect(FRAME_OUTPUT_LIMITS.maxDimension).toBe(1920);
  });
});
