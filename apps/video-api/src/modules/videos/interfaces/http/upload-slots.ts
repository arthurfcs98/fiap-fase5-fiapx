/**
 * Uploads being streamed by THIS replica (D1/M2 of the review): each one holds the S3 part
 * buffers of `lib-storage` (~10 MiB with 5 MiB parts and 1 in flight), so an unbounded number
 * of concurrent large uploads would OOM-kill the pod and every upload in progress with it.
 * Beyond `limit` the upload is refused BEFORE reading the body (`503 X0003` + `Retry-After`).
 *
 * Also counts the uploads in flight per user (they are not in the database yet): part of the
 * per-user limit of videos in progress (`MAX_PENDING_VIDEOS_PER_USER`).
 */
export class UploadSlots {
  private active = 0;
  private readonly byUser = new Map<string, number>();

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`limite de uploads simultâneos inválido: ${limit}`);
    }
  }

  /** Uploads in progress in this replica. */
  get inUse(): number {
    return this.active;
  }

  /** Uploads of `userId` in progress in this replica. */
  inFlightFor(userId: string): number {
    return this.byUser.get(userId) ?? 0;
  }

  /**
   * Takes a slot for `userId`; `null` when the replica is full. The returned function frees it
   * (calling it again does nothing).
   */
  tryAcquire(userId: string): (() => void) | null {
    if (this.active >= this.limit) return null;
    this.active += 1;
    this.byUser.set(userId, this.inFlightFor(userId) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const remaining = this.inFlightFor(userId) - 1;
      if (remaining > 0) this.byUser.set(userId, remaining);
      else this.byUser.delete(userId);
    };
  }
}

/** Injection token of the replica's {@link UploadSlots}. */
export const UPLOAD_SLOTS = Symbol('UPLOAD_SLOTS');

/** `Retry-After` when the replica is busy: a slot usually frees in seconds. */
export const UPLOAD_BUSY_RETRY_AFTER_SECONDS = 5;
