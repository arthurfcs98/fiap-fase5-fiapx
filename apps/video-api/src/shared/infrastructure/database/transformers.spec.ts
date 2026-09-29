import { bigintToNumber } from './transformers';

describe('bigintToNumber', () => {
  it('converts the pg string to number and keeps null', () => {
    expect(bigintToNumber.from('10485760')).toBe(10_485_760);
    expect(bigintToNumber.from(42)).toBe(42);
    expect(bigintToNumber.from(null)).toBeNull();
    expect(bigintToNumber.to(7)).toBe(7);
  });
});
