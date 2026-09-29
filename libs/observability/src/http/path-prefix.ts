/**
 * `true` quando o caminho da URL (sem query string) é um dos prefixos ou está abaixo dele:
 * `/api/health` casa com `/api/health` e `/api/health/live`, mas não com `/api/healthcheck`.
 */
export function matchesPathPrefix(url: string | undefined, prefixes: readonly string[]): boolean {
  const path = (url ?? '').split('?')[0] ?? '';
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
