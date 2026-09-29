import { matchesPathPrefix } from './path-prefix';

describe('matchesPathPrefix', () => {
  const prefixes = ['/api/health', '/api/docs'];

  it.each([
    ['/api/health', true],
    ['/api/health/live', true],
    ['/api/health/ready?full=1', true],
    ['/api/docs/swagger-ui.css', true],
    ['/api/healthcheck', false],
    ['/api/videos', false],
    ['', false],
    [undefined, false],
  ])('%p → %p', (url, expected) => {
    expect(matchesPathPrefix(url, prefixes)).toBe(expected);
  });

  it('lista vazia não ignora nada', () => {
    expect(matchesPathPrefix('/api/health', [])).toBe(false);
  });
});
