/**
 * Objects of a user in a bucket, by key prefix `{userId}/` (contratos.md, section 7). Used by the
 * LGPD erasure and by the orphan sweep.
 */
export interface UserObjectStore {
  /** Top-level prefixes (`{userId}/`) present in the bucket, without the slash. */
  listOwnerIds(bucket: string): Promise<string[]>;
  /** Deletes every object under `{ownerId}/`; returns how many were deleted. */
  deleteAllOf(bucket: string, ownerId: string): Promise<number>;
}

export const USER_OBJECT_STORE = Symbol('USER_OBJECT_STORE');
