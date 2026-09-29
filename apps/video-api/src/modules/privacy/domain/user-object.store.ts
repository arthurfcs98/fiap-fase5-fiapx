/** One stored object (key and upload time). */
export interface StoredObjectInfo {
  key: string;
  lastModified?: Date;
}

/**
 * Bucket-wide operations of the LGPD housekeeping (contratos.md, sections 7 and 12): objects of
 * a user by key prefix `{userId}/` (erasure and orphan sweep), the full listing of a bucket
 * (leftover originals) and the incomplete multipart uploads (interrupted uploads).
 */
export interface UserObjectStore {
  /** Top-level prefixes (`{userId}/`) present in the bucket, without the slash. */
  listOwnerIds(bucket: string): Promise<string[]>;
  /** Deletes every object under `{ownerId}/`; returns how many were deleted. */
  deleteAllOf(bucket: string, ownerId: string): Promise<number>;
  /** Every object of the bucket (paginated internally). */
  listObjects(bucket: string): Promise<StoredObjectInfo[]>;
  /**
   * Aborts the multipart uploads started before `initiatedBefore` that never completed (their
   * parts are video content nobody can see or delete otherwise); returns how many.
   */
  abortIncompleteUploads(bucket: string, initiatedBefore: Date): Promise<number>;
}

export const USER_OBJECT_STORE = Symbol('USER_OBJECT_STORE');
