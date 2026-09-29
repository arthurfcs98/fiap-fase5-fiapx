import { HealthRegistry } from './health-registry';

describe('HealthRegistry', () => {
  it('lista só as verificações que falham; exceção conta como falha', () => {
    const registry = new HealthRegistry();
    registry.register('consumidores', () => true);
    registry.register('fila-x', () => false);
    registry.register('quebrada', () => {
      throw new Error('boom');
    });

    expect(registry.failing()).toEqual(['fila-x', 'quebrada']);
  });

  it('register substitui pelo nome e unregister remove', () => {
    const registry = new HealthRegistry();
    registry.register('x', () => false);
    registry.register('x', () => true);
    expect(registry.failing()).toEqual([]);

    registry.register('y', () => false);
    registry.unregister('y');
    expect(registry.failing()).toEqual([]);
  });
});
