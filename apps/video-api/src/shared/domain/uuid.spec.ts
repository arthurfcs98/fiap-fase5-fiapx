import { isUuid } from './uuid';

describe('isUuid', () => {
  it.each([
    ['6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b', true],
    ['6F1C2B3A-4D5E-4F60-8A7B-9C0D1E2F3A4B', true],
    ['123', false],
    ['6f1c2b3a4d5e4f608a7b9c0d1e2f3a4b', false],
    [42, false],
    [undefined, false],
  ])('isUuid(%p) → %p', (value, expected) => {
    expect(isUuid(value)).toBe(expected);
  });
});
