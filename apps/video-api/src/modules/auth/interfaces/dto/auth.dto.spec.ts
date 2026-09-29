import { loginSchema, registerSchema } from './auth.dto';

const valid = {
  name: '  Ana Souza ',
  email: ' Ana@Example.COM ',
  password: 'senha-forte-123',
  acceptPrivacyPolicy: true,
};

describe('auth DTO schemas', () => {
  it('register normalizes name and e-mail', () => {
    expect(registerSchema.parse(valid)).toEqual({
      name: 'Ana Souza',
      email: 'ana@example.com',
      password: 'senha-forte-123',
      acceptPrivacyPolicy: true,
    });
  });

  it.each([
    ['no privacy consent', { acceptPrivacyPolicy: undefined }, 'acceptPrivacyPolicy'],
    ['consent false', { acceptPrivacyPolicy: false }, 'acceptPrivacyPolicy'],
    ['short password', { password: 'curta' }, 'password'],
    ['password over 72 bytes', { password: 'é'.repeat(37) }, 'password'],
    ['invalid e-mail', { email: 'ana' }, 'email'],
    ['empty name', { name: '   ' }, 'name'],
    ['long name', { name: 'a'.repeat(121) }, 'name'],
    ['link in the name (phishing via our e-mails)', { name: 'Pix bloqueado http://x.io' }, 'name'],
    ['www address in the name', { name: 'Acesse WWW.golpe.com' }, 'name'],
  ])('register rejects %s', (_case, patch, field) => {
    const result = registerSchema.safeParse({ ...valid, ...patch });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toContain(field);
  });

  it('consent error message is in pt-BR', () => {
    const result = registerSchema.safeParse({ ...valid, acceptPrivacyPolicy: false });
    expect(result.error?.issues[0]?.message).toContain('política de privacidade');
  });

  it('login requires e-mail and password', () => {
    expect(loginSchema.parse({ email: 'ANA@example.com', password: 'x' })).toEqual({
      email: 'ana@example.com',
      password: 'x',
    });
    expect(loginSchema.safeParse({ email: 'ana@example.com', password: '' }).success).toBe(false);
  });
});
