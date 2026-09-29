import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';

/** bcrypt ignores what comes after 72 bytes, so the limit is enforced here (UTF-8 bytes). */
export const PASSWORD_MAX_BYTES = 72;

const email = z
  .string({ error: 'Informe o e-mail.' })
  .trim()
  .toLowerCase()
  .max(254, 'E-mail longo demais.')
  .pipe(z.email({ error: 'Informe um e-mail válido.' }));

/**
 * The name goes into the e-mails sent by `frames@asdevit.com` (greeting): link-like text
 * (`http://`, `www.`) would let anyone use the notifications to send phishing links from our
 * domain to an address they do not own (sign-up e-mails are not verified).
 */
const LINK_LIKE = /:\/\/|www\./i;

export const registerSchema = z.object({
  name: z
    .string({ error: 'Informe o nome.' })
    .trim()
    .min(1, 'Informe o nome.')
    .max(120, 'O nome pode ter no máximo 120 caracteres.')
    .refine((value) => !LINK_LIKE.test(value), 'O nome não pode conter endereços de sites.'),
  email,
  password: z
    .string({ error: 'Informe a senha.' })
    .min(8, 'A senha precisa ter pelo menos 8 caracteres.')
    .refine(
      (value) => Buffer.byteLength(value, 'utf8') <= PASSWORD_MAX_BYTES,
      `A senha pode ter no máximo ${PASSWORD_MAX_BYTES} bytes.`,
    ),
  /** LGPD (contratos.md, section 12): sign-up requires explicit consent. */
  acceptPrivacyPolicy: z.literal(true, {
    error: 'É preciso aceitar a política de privacidade (acceptPrivacyPolicy: true).',
  }),
});

export type RegisterRequest = z.output<typeof registerSchema>;

export const loginSchema = z.object({
  email,
  password: z.string({ error: 'Informe a senha.' }).min(1, 'Informe a senha.').max(1024),
});

export type LoginRequest = z.output<typeof loginSchema>;

export class RegisterRequestDto {
  @ApiProperty({ example: 'Ana Souza', maxLength: 120 })
  name!: string;

  @ApiProperty({ example: 'ana@example.com', format: 'email' })
  email!: string;

  @ApiProperty({
    example: 'uma-senha-forte-123',
    minLength: 8,
    description: 'Até 72 bytes (UTF-8)',
  })
  password!: string;

  @ApiProperty({
    example: true,
    enum: [true],
    description: 'Aceite obrigatório da política de privacidade (/privacidade.html)',
  })
  acceptPrivacyPolicy!: true;
}

export class LoginRequestDto {
  @ApiProperty({ example: 'ana@example.com', format: 'email' })
  email!: string;

  @ApiProperty({ example: 'uma-senha-forte-123' })
  password!: string;
}

export class UserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Ana Souza' })
  name!: string;

  @ApiProperty({ example: 'ana@example.com' })
  email!: string;
}

export class AccessTokenResponseDto {
  @ApiProperty({ description: 'JWT HS256' })
  accessToken!: string;

  @ApiProperty({ example: 'Bearer', enum: ['Bearer'] })
  tokenType!: 'Bearer';

  @ApiProperty({ example: 3600, description: 'Validade em segundos' })
  expiresIn!: number;
}
