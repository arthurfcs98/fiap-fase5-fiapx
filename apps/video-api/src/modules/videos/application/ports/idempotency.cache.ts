/**
 * Fast path of the upload `Idempotency-Key` (Redis): key → video id. Best effort: the source of
 * truth is the unique index `(user_id, idempotency_key)`, so implementations never throw.
 */
export interface IdempotencyCache {
  get(userId: string, idempotencyKey: string): Promise<string | undefined>;
  remember(userId: string, idempotencyKey: string, videoId: string): Promise<void>;
}

export const IDEMPOTENCY_CACHE = Symbol('IDEMPOTENCY_CACHE');
