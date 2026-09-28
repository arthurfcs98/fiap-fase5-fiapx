import * as testing from '@fiapx/storage/testing';
import * as storage from './index';

describe('barrel de @fiapx/storage', () => {
  it('não exporta o fake em memória (não entra no bundle de produção)', () => {
    expect(Object.keys(storage)).not.toContain('InMemoryObjectStorage');
    expect(storage.BUCKETS.raw).toBe('fiapx-raw');
  });

  it('expõe o fake pelo subpath @fiapx/storage/testing', () => {
    expect(new testing.InMemoryObjectStorage().size).toBe(0);
  });
});
