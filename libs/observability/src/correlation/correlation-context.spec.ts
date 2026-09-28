import { getCorrelationId, resolveCorrelationId, runWithCorrelation } from './correlation-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('correlation context', () => {
  it('não há correlation id fora de um contexto', () => {
    expect(getCorrelationId()).toBeUndefined();
  });

  it('runWithCorrelation propaga o id por callbacks assíncronos', async () => {
    const seen = await runWithCorrelation('abc-123', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return getCorrelationId();
    });
    expect(seen).toBe('abc-123');
    expect(getCorrelationId()).toBeUndefined();
  });

  it('contextos aninhados não vazam um para o outro', () => {
    runWithCorrelation('externo', () => {
      runWithCorrelation('interno', () => expect(getCorrelationId()).toBe('interno'));
      expect(getCorrelationId()).toBe('externo');
    });
  });

  it('gera um UUID quando o id é ausente', () => {
    expect(runWithCorrelation(undefined, getCorrelationId)).toMatch(UUID);
  });

  describe('resolveCorrelationId', () => {
    it.each(['abc', 'req-1.2:3_x', 'a'.repeat(100)])('reaproveita id seguro %p', (id) => {
      expect(resolveCorrelationId(id)).toBe(id);
    });

    it.each([undefined, '', 'a'.repeat(101), 'com espaço', 'quebra\nde-linha', 42, {}])(
      'gera UUID para valor inseguro/ausente %p',
      (value) => {
        expect(resolveCorrelationId(value)).toMatch(UUID);
      },
    );

    it('usa o primeiro valor quando o header vem repetido', () => {
      expect(resolveCorrelationId(['primeiro', 'segundo'])).toBe('primeiro');
    });
  });
});
