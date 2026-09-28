import { BUCKETS, rawVideoKey, zipKey } from './object-keys';

const USER = '1a2b3c4d-5e6f-4a0b-9c1d-2e3f4a5b6c7d';
const VIDEO = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';

describe('chaves de storage', () => {
  it('define os buckets do projeto', () => {
    expect(BUCKETS).toEqual({ raw: 'fiapx-raw', zips: 'fiapx-zips' });
  });

  it('monta a chave do vídeo original normalizando a extensão', () => {
    expect(rawVideoKey(USER, VIDEO, '.MP4')).toBe(`${USER}/${VIDEO}.mp4`);
    expect(rawVideoKey(USER, VIDEO, 'mkv')).toBe(`${USER}/${VIDEO}.mkv`);
  });

  it('monta a chave determinística do zip', () => {
    expect(zipKey(USER, VIDEO)).toBe(`${USER}/${VIDEO}.zip`);
  });

  it.each([
    ['userId', () => rawVideoKey('../etc', VIDEO, 'mp4')],
    ['videoId', () => zipKey(USER, 'video.mp4')],
    ['userId', () => zipKey('', VIDEO)],
  ])('rejeita %s que não é UUID (sem path traversal)', (label, build) => {
    expect(build).toThrow(new RegExp(`${label} inválido`));
  });

  it.each(['', 'm', 'mp4/../x', 'toolong', 'mp 4'])('rejeita extensão %p', (ext) => {
    expect(() => rawVideoKey(USER, VIDEO, ext)).toThrow(/Extensão inválida/);
  });
});
