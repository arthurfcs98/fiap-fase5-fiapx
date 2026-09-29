import { HmacDownloadSigner } from './hmac-download.signer';

describe('HmacDownloadSigner', () => {
  const signer = new HmacDownloadSigner('s'.repeat(48));
  const id = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';

  it('signs deterministically in base64url and verifies its own signature', () => {
    const sig = signer.sign(id, 1_900_000_000);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signer.sign(id, 1_900_000_000)).toBe(sig);
    expect(signer.verify(id, 1_900_000_000, sig)).toBe(true);
  });

  it('rejects another video, another expiry, another key or a malformed signature', () => {
    const sig = signer.sign(id, 1_900_000_000);
    expect(signer.verify('00000000-0000-4000-8000-000000000000', 1_900_000_000, sig)).toBe(false);
    expect(signer.verify(id, 1_900_000_001, sig)).toBe(false);
    expect(new HmacDownloadSigner('x'.repeat(48)).verify(id, 1_900_000_000, sig)).toBe(false);
    expect(signer.verify(id, 1_900_000_000, 'curta')).toBe(false);
  });
});
