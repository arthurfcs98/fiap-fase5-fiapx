import { AppErrorException } from '@fiapx/common';
import {
  aUser,
  FakePasswordHasher,
  FixedClock,
  InMemoryUserRepository,
  NOW,
} from '../../../../../test/support/fakes';
import { EmailAlreadyRegisteredError } from '../../domain/user.repository';
import { RegisterUserUseCase } from './register-user.use-case';

function setup() {
  const users = new InMemoryUserRepository();
  const useCase = new RegisterUserUseCase(users, new FakePasswordHasher(), new FixedClock(), {
    privacyPolicyVersion: '2026-09-28',
  });
  return { users, useCase };
}

const input = {
  name: 'Ana Souza',
  email: 'ana@example.com',
  password: 'senha-forte-123',
  acceptPrivacyPolicy: true as const,
};

describe('RegisterUserUseCase', () => {
  it('stores the hash (never the password) and the privacy consent', async () => {
    const { users, useCase } = setup();

    const view = await useCase.execute(input);

    expect(view).toEqual({ id: expect.any(String), name: 'Ana Souza', email: 'ana@example.com' });
    const stored = users.users.get(view.id);
    expect(stored).toMatchObject({
      passwordHash: 'hash:senha-forte-123',
      privacyAcceptedAt: NOW,
      privacyPolicyVersion: '2026-09-28',
      createdAt: NOW,
    });
    expect(JSON.stringify(view)).not.toContain('senha');
  });

  it('e-mail already registered → 409 A0002', async () => {
    const { users, useCase } = setup();
    users.users.set('x', aUser({ id: 'x', email: 'ana@example.com' }));

    await expect(useCase.execute(input)).rejects.toMatchObject({
      appError: { code: 'A0002', httpStatus: 409 },
    });
  });

  it('race on the unique index → 409 A0002', async () => {
    const { users, useCase } = setup();
    users.failNextInsert = new EmailAlreadyRegisteredError();

    const error = await useCase.execute(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppErrorException);
    expect((error as AppErrorException).appError.code).toBe('A0002');
  });

  it('other persistence errors propagate', async () => {
    const { users, useCase } = setup();
    users.failNextInsert = new Error('db down');
    await expect(useCase.execute(input)).rejects.toThrow('db down');
  });
});
