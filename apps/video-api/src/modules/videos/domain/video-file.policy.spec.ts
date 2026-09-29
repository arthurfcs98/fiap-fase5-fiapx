import {
  ALLOWED_EXTENSIONS,
  containerMatchesExtension,
  extensionOf,
  isAllowedExtension,
  sanitizeOriginalName,
} from './video-file.policy';

describe('video file policy', () => {
  it('accepts exactly the extensions of the base project', () => {
    expect(ALLOWED_EXTENSIONS).toEqual(['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm']);
    expect(isAllowedExtension('.mp4')).toBe(true);
    expect(isAllowedExtension('.m3u8')).toBe(false);
    expect(isAllowedExtension('')).toBe(false);
  });

  it.each([
    ['video.MP4', '.mp4'],
    ['a.b.mkv', '.mkv'],
    ['sem-extensao', ''],
    ['.hidden', ''],
    ['ponto-no-fim.', ''],
  ])('extensionOf(%p) → %p', (name, expected) => {
    expect(extensionOf(name)).toBe(expected);
  });

  it('requires the detected container to match the extension family', () => {
    expect(containerMatchesExtension('.mp4', 'mov')).toBe(true);
    expect(containerMatchesExtension('.wmv', 'asf')).toBe(true);
    expect(containerMatchesExtension('.webm', 'mkv')).toBe(true);
    expect(containerMatchesExtension('.avi', 'mp4')).toBe(false);
    expect(containerMatchesExtension('.mp4', 'png')).toBe(false);
    expect(containerMatchesExtension('.mp4', undefined)).toBe(false);
  });

  it('keeps only the base name without control characters', () => {
    expect(sanitizeOriginalName('C:\\Users\\ana\\férias 2026.mp4')).toBe('férias 2026.mp4');
    expect(sanitizeOriginalName('../../etc/passwd.mp4')).toBe('passwd.mp4');
    expect(sanitizeOriginalName(' a\u0000b\u001f\u007f.mov ')).toBe('ab.mov');
  });

  it('cuts long names to 255 characters keeping the extension', () => {
    const name = sanitizeOriginalName(`${'x'.repeat(300)}.webm`);
    expect(name).toHaveLength(255);
    expect(name.endsWith('.webm')).toBe(true);

    const weird = sanitizeOriginalName(`${'y'.repeat(300)}.${'z'.repeat(20)}`);
    expect(weird).toHaveLength(255);
  });
});
