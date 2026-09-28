import { z } from 'zod';
import { metricsServerConfigShape } from './metrics.config';

const schema = z.object(metricsServerConfigShape);

describe('metricsServerConfigShape', () => {
  it('aplica defaults (porta 9464, todas as interfaces, sem token)', () => {
    expect(schema.parse({})).toEqual({ METRICS_PORT: 9464, METRICS_HOST: '0.0.0.0' });
  });

  it('aceita porta e token válidos', () => {
    expect(schema.parse({ METRICS_PORT: '9500', METRICS_TOKEN: 'x'.repeat(16) })).toMatchObject({
      METRICS_PORT: 9500,
      METRICS_TOKEN: 'x'.repeat(16),
    });
  });

  it('rejeita token curto', () => {
    const result = schema.safeParse({ METRICS_TOKEN: 'curto' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('16 caracteres');
  });
});

describe('METRICS_PORT', () => {
  it.each([
    ['0', true],
    ['65535', true],
    ['-1', false],
    ['70000', false],
    ['abc', false],
  ])('%p válido? %p', (port, valid) => {
    expect(schema.safeParse({ METRICS_PORT: port }).success).toBe(valid);
  });
});
