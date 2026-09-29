import {
  aUser,
  FakePasswordHasher,
  FakeTokenIssuer,
  InMemoryUserRepository,
  USER_ID,
} from '../../../../../test/support/fakes';
import { LoginUseCase, TIMING_EQUALIZER_HASH } from './login.use-case';

function setup() {
  const users = new InMemoryUserRepository();
  users.users.set(USER_ID, aUser());
  const hasher = new FakePasswordHasher();
  const verify = jest.spyOn(hasher, 'verify');
  return { useCase: new LoginUseCase(users, hasher, new FakeTokenIssuer()), verify };
}

describe('LoginUseCase', () => {
  it('valid credentials → Bearer token', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute({ email: 'ana@example.com', password: 'senha-forte-123' }),
    ).resolves.toEqual({ accessToken: `token-${USER_ID}`, tokenType: 'Bearer', expiresIn: 3600 });
  });

  it('wrong password → 401 A0001', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute({ email: 'ana@example.com', password: 'errada' }),
    ).rejects.toMatchObject({ appError: { code: 'A0001', httpStatus: 401 } });
  });

  it('unknown e-mail → the same 401 A0001, after a bcrypt compare (no timing oracle)', async () => {
    const { useCase, verify } = setup();
    await expect(
      useCase.execute({ email: 'ninguem@example.com', password: 'x' }),
    ).rejects.toMatchObject({ appError: { code: 'A0001' } });
    expect(verify).toHaveBeenCalledWith('x', TIMING_EQUALIZER_HASH);
  });
});
