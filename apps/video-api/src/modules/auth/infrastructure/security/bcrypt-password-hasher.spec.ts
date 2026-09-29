import { getRounds } from 'bcryptjs';
import { BCRYPT_COST } from '../../auth.constants';
import { BcryptPasswordHasher } from './bcrypt-password-hasher';

describe('BcryptPasswordHasher', () => {
  it('uses cost 12 by default (contract)', () => {
    expect(BCRYPT_COST).toBe(12);
  });

  it('timing equalizer: one hash per process, same cost, of a value nobody knows', async () => {
    const hasher = new BcryptPasswordHasher(4);
    const equalizer = await hasher.timingEqualizerHash();

    expect(getRounds(equalizer)).toBe(4);
    await expect(hasher.timingEqualizerHash()).resolves.toBe(equalizer); // memoized
    await expect(hasher.verify('', equalizer)).resolves.toBe(false);
    await expect(new BcryptPasswordHasher(4).timingEqualizerHash()).resolves.not.toBe(equalizer);
  });

  it('computes the timing equalizer at module init', async () => {
    const hasher = new BcryptPasswordHasher(4);
    const spy = jest.spyOn(hasher, 'timingEqualizerHash');
    await hasher.onModuleInit();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('hashes and verifies (low cost in the test for speed)', async () => {
    const hasher = new BcryptPasswordHasher(4);
    const hashed = await hasher.hash('s3nha-forte');

    expect(hashed).not.toContain('s3nha-forte');
    expect(getRounds(hashed)).toBe(4);
    await expect(hasher.verify('s3nha-forte', hashed)).resolves.toBe(true);
    await expect(hasher.verify('outra-senha', hashed)).resolves.toBe(false);
  });

  it('defaults to the contract cost', async () => {
    const hashed = await new BcryptPasswordHasher().hash('x');
    expect(getRounds(hashed)).toBe(12);
  });
});
