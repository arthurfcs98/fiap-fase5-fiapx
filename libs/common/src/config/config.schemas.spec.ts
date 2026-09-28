import { z } from 'zod';
import { csvList, envBoolean, logLevelSchema, nodeEnvSchema, portSchema } from './config.schemas';

describe('config.schemas', () => {
  it('portSchema aceita portas válidas e rejeita inválidas', () => {
    expect(portSchema.parse('3000')).toBe(3000);
    expect(portSchema.safeParse('0').success).toBe(false);
    expect(portSchema.safeParse('65536').success).toBe(false);
    expect(portSchema.safeParse('abc').success).toBe(false);
    expect(portSchema.safeParse('30.5').success).toBe(false);
  });

  it('logLevelSchema aceita níveis do pino (incl. silent) com default info', () => {
    expect(logLevelSchema.parse(undefined)).toBe('info');
    expect(logLevelSchema.parse('silent')).toBe('silent');
    expect(logLevelSchema.safeParse('verbose').success).toBe(false);
  });

  it('nodeEnvSchema tem default development', () => {
    expect(nodeEnvSchema.parse(undefined)).toBe('development');
    expect(nodeEnvSchema.parse('production')).toBe('production');
  });

  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['false', false],
    ['0', false],
    ['off', false],
  ])('envBoolean interpreta %p como %p', (raw, expected) => {
    expect(envBoolean(!expected).parse(raw)).toBe(expected);
  });

  it('envBoolean usa o default e rejeita valores ambíguos', () => {
    expect(envBoolean(true).parse(undefined)).toBe(true);
    expect(envBoolean(false).parse(undefined)).toBe(false);
    expect(envBoolean(false).safeParse('talvez').success).toBe(false);
  });

  it('csvList separa por vírgula e descarta itens vazios', () => {
    expect(csvList.parse(' mp4, mkv,,avi ')).toEqual(['mp4', 'mkv', 'avi']);
    expect(z.object({ L: csvList }).parse({ L: '' })).toEqual({ L: [] });
  });
});
