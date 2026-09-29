import path from 'node:path';
import { resolvePublicDir } from './static-assets';

describe('resolvePublicDir', () => {
  it('prefers public/ next to the bundle (image), then ../public (sources)', () => {
    expect(resolvePublicDir('/app/dist', (dir) => dir === '/app/dist/public')).toBe(
      '/app/dist/public',
    );
    expect(
      resolvePublicDir('/repo/apps/video-api/src', (dir) => dir.endsWith('video-api/public')),
    ).toBe('/repo/apps/video-api/public');
    expect(resolvePublicDir('/nowhere', () => false)).toBe('/nowhere/public');
  });

  it('finds apps/video-api/public from the sources', () => {
    expect(resolvePublicDir()).toBe(path.resolve(__dirname, '..', 'public'));
  });
});
