import type { ValueTransformer } from 'typeorm';

/**
 * `bigint` columns come back from `pg` as strings (to avoid precision loss above 2^53). Sizes in
 * bytes stay far below that, so they are exposed as numbers.
 */
export const bigintToNumber: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | number | null) => (value === null ? null : Number(value)),
};
