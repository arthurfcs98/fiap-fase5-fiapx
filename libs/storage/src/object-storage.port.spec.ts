import { ObjectNotFoundError, ObjectStorageError, OBJECT_STORAGE } from './object-storage.port';

describe('erros da porta de storage', () => {
  it('ObjectNotFoundError identifica bucket e chave', () => {
    expect(new ObjectNotFoundError('b', 'k')).toMatchObject({
      name: 'ObjectNotFoundError',
      bucket: 'b',
      key: 'k',
      message: 'Objeto não encontrado: b/k',
    });
  });

  it('ObjectStorageError descreve operação, alvo e causa', () => {
    const cause = new Error('ECONNREFUSED');
    expect(new ObjectStorageError('put', 'b', 'k', { cause })).toMatchObject({
      name: 'ObjectStorageError',
      operation: 'put',
      message: 'Falha no storage (put b/k): ECONNREFUSED',
      cause,
    });
    expect(new ObjectStorageError('checkBucket', 'b', undefined).message).toBe(
      'Falha no storage (checkBucket b)',
    );
  });

  it('exporta o token de injeção', () => {
    expect(typeof OBJECT_STORAGE).toBe('symbol');
  });
});
