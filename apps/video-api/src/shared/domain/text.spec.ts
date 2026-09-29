import { truncate } from './text';

describe('truncate', () => {
  it('keeps short values and cuts long ones', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdef', 3)).toBe('abc');
  });
});
