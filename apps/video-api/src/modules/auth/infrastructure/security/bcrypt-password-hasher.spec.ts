import { getRounds } from 'bcryptjs';
import { BCRYPT_COST } from '../../auth.constants';
import { TIMING_EQUALIZER_HASH } from '../../application/use-cases/login.use-case';
import { BcryptPasswordHasher } from './bcrypt-password-hasher';

describe('BcryptPasswordHasher', () => {
  it('uses cost 12 by default (contract) and the timing equalizer hash has the same cost', () => {
    expect(BCRYPT_COST).toBe(12);
    expect(getRounds(TIMING_EQUALIZER_HASH)).toBe(BCRYPT_COST);
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
