/** Cuts `value` to at most `max` characters (column limits such as `varchar(500)`). */
export function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
