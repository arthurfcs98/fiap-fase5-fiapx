import { Inject, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { ConfigValidationError } from './load-config';
import { TypedConfigModule } from './typed-config.module';

const TEST_CONFIG = Symbol('TEST_CONFIG');
const schema = z.object({ GREETING: z.string().default('olá') });

@Injectable()
class Consumer {
  constructor(@Inject(TEST_CONFIG) readonly config: z.output<typeof schema>) {}
}

describe('TypedConfigModule', () => {
  it('disponibiliza a configuração validada pelo token (módulo global)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TypedConfigModule.forRoot({ token: TEST_CONFIG, schema, env: { GREETING: 'oi' } })],
      providers: [Consumer],
    }).compile();

    expect(moduleRef.get(Consumer).config).toEqual({ GREETING: 'oi' });
  });

  it('usa process.env quando env não é informado', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TypedConfigModule.forRoot({ token: TEST_CONFIG, schema })],
    }).compile();

    expect(moduleRef.get(TEST_CONFIG)).toEqual({ GREETING: process.env['GREETING'] ?? 'olá' });
  });

  it('falha no boot com configuração inválida (fail fast)', async () => {
    const strict = z.object({ REQUIRED_VALUE: z.string() });
    await expect(
      Test.createTestingModule({
        imports: [TypedConfigModule.forRoot({ token: TEST_CONFIG, schema: strict, env: {} })],
      }).compile(),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });
});
