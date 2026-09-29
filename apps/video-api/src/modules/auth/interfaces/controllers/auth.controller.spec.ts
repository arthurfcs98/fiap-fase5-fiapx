import { USER_ID } from '../../../../../test/support/fakes';
import type { GetProfileUseCase } from '../../application/use-cases/get-profile.use-case';
import type { LoginUseCase } from '../../application/use-cases/login.use-case';
import type { RegisterUserUseCase } from '../../application/use-cases/register-user.use-case';
import { AuthController } from './auth.controller';

describe('AuthController', () => {
  it('delegates to the use cases', async () => {
    const view = { id: USER_ID, name: 'Ana', email: 'ana@example.com' };
    const token = { accessToken: 't', tokenType: 'Bearer' as const, expiresIn: 3600 };
    const register = { execute: jest.fn().mockResolvedValue(view) };
    const login = { execute: jest.fn().mockResolvedValue(token) };
    const profile = { execute: jest.fn().mockResolvedValue(view) };
    const controller = new AuthController(
      register as unknown as RegisterUserUseCase,
      login as unknown as LoginUseCase,
      profile as unknown as GetProfileUseCase,
    );

    const body = {
      name: 'Ana',
      email: 'ana@example.com',
      password: 'x'.repeat(8),
      acceptPrivacyPolicy: true as const,
    };
    await expect(controller.register(body)).resolves.toBe(view);
    await expect(
      controller.authenticate({ email: 'ana@example.com', password: 'x' }),
    ).resolves.toBe(token);
    await expect(controller.me({ id: USER_ID })).resolves.toBe(view);
    expect(profile.execute).toHaveBeenCalledWith(USER_ID);
  });
});
