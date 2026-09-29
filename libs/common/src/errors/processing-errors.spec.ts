import { AppError } from './app-error';
import {
  isNonRetryableError,
  isRetryableError,
  NonRetryableError,
  RetryableError,
} from './processing-errors';

describe('RetryableError', () => {
  it('marca a falha como transitória e preserva a causa', () => {
    const cause = new Error('ECONNRESET');
    const error = new RetryableError('BROKER_UNAVAILABLE', { cause });

    expect(error.retryable).toBe(true);
    expect(error.reason).toBe('BROKER_UNAVAILABLE');
    expect(error.message).toBe('Falha transitória: BROKER_UNAVAILABLE');
    expect(error.name).toBe('RetryableError');
    expect(error.cause).toBe(cause);
    expect(isRetryableError(error)).toBe(true);
  });
});

describe('NonRetryableError', () => {
  it('carrega o AppError e não é retentável', () => {
    const appError = new AppError(422, 'NO_FRAMES', 'P0002', 'Sem frames.');
    const error = new NonRetryableError(appError);

    expect(error.retryable).toBe(false);
    expect(error.appError).toBe(appError);
    expect(error.message).toBe('P0002 NO_FRAMES: Sem frames.');
    expect(error.name).toBe('NonRetryableError');
    expect(isRetryableError(error)).toBe(false);
  });

  it('isRetryableError é falso para erros comuns', () => {
    expect(isRetryableError(new Error('x'))).toBe(false);
    expect(isRetryableError('x')).toBe(false);
  });
});

describe('isNonRetryableError', () => {
  it('reconhece só NonRetryableError', () => {
    const appError = new AppError(422, 'NO_FRAMES', 'P0002', 'Sem frames.');
    expect(isNonRetryableError(new NonRetryableError(appError))).toBe(true);
    expect(isNonRetryableError(new RetryableError('x'))).toBe(false);
    expect(isNonRetryableError(undefined)).toBe(false);
  });
});
