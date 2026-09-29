import { testConfig } from '../../../../../test/support/config';
import { aUser, InMemoryUserRepository, USER_ID } from '../../../../../test/support/fakes';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  const users = new InMemoryUserRepository();
  users.users.set(USER_ID, aUser());
  const strategy = new JwtStrategy(testConfig(), users);

  it('accepts a token whose user still exists and exposes only the id', async () => {
    await expect(strategy.validate({ sub: USER_ID })).resolves.toEqual({ id: USER_ID });
  });

  it('rejects tokens of deleted users (LGPD erasure revokes old tokens)', async () => {
    await expect(
      strategy.validate({ sub: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toMatchObject({ appError: { code: 'A0003' } });
  });

  it('rejects a malformed subject without querying uuid columns', async () => {
    const findById = jest.spyOn(users, 'findById');
    await expect(strategy.validate({ sub: 'not-a-uuid' })).rejects.toMatchObject({
      appError: { code: 'A0003' },
    });
    await expect(strategy.validate({})).rejects.toMatchObject({ appError: { code: 'A0003' } });
    expect(findById).not.toHaveBeenCalled();
  });
});
