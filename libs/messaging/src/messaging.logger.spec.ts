import { Logger } from '@nestjs/common';
import { defaultLogger, describeError } from './messaging.logger';

describe('messaging.logger', () => {
  it('describeError resume Error e valores quaisquer', () => {
    expect(describeError(new TypeError('x'))).toBe('TypeError: x');
    expect(describeError('texto')).toBe('texto');
    expect(describeError(undefined)).toBe('undefined');
  });

  it('defaultLogger usa o Logger do Nest com o contexto', () => {
    expect(defaultLogger('Ctx')).toBeInstanceOf(Logger);
  });
});
