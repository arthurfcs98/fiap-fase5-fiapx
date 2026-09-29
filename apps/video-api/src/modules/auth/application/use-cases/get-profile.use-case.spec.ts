import { aUser, InMemoryUserRepository, USER_ID } from '../../../../../test/support/fakes';
import { GetProfileUseCase } from './get-profile.use-case';

describe('GetProfileUseCase', () => {
  it('returns id, name and e-mail only', async () => {
    const users = new InMemoryUserRepository();
    users.users.set(USER_ID, aUser());
    await expect(new GetProfileUseCase(users).execute(USER_ID)).resolves.toEqual({
      id: USER_ID,
      name: 'Ana Souza',
      email: 'ana@example.com',
    });
  });

  it('deleted user → 401 A0003', async () => {
    await expect(
      new GetProfileUseCase(new InMemoryUserRepository()).execute(USER_ID),
    ).rejects.toMatchObject({ appError: { code: 'A0003' } });
  });
});
