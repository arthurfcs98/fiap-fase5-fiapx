import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';

export const deleteAccountSchema = z.object({
  password: z
    .string({ error: 'Informe a senha para confirmar.' })
    .min(1, 'Informe a senha para confirmar.')
    .max(1024),
});

export type DeleteAccountRequest = z.output<typeof deleteAccountSchema>;

export class DeleteAccountRequestDto {
  @ApiProperty({ description: 'Senha atual, para confirmar a eliminação da conta' })
  password!: string;
}
