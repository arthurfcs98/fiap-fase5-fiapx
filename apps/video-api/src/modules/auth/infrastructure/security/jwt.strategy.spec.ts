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

  it('database down while looking the user up → 503 X0003 (not 401: the session stays)', async () => {
    const down = new InMemoryUserRepository();
    jest
      .spyOn(down, 'findById')
      .mockRejectedValue(
        Object.assign(new Error('getaddrinfo ENOTFOUND postgres'), { code: 'ENOTFOUND' }),
      );
    const failing = new JwtStrategy(testConfig(), down);

    await expect(failing.validate({ sub: USER_ID })).rejects.toMatchObject({
      appError: { code: 'X0003', httpStatus: 503, metadata: { retryAfterSeconds: 5 } },
    });
  });

  it('non-Error repository failures are also a 503', async () => {
    const down = new InMemoryUserRepository();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- non-Error on purpose
    jest.spyOn(down, 'findById').mockReturnValue(Promise.reject('timeout'));

    await expect(
      new JwtStrategy(testConfig(), down).validate({ sub: USER_ID }),
    ).rejects.toMatchObject({ appError: { code: 'X0003' } });
  });
});
