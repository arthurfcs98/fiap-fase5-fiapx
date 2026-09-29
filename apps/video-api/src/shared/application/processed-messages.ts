/**
 * Consumer idempotency (`processed_messages`, contratos.md section 5): the insert happens in the
 * same transaction as the state change, so a redelivered message has no effect.
 */
export interface ProcessedMessages {
  /** `true` the first time `(messageId, consumer)` is seen in this transaction. */
  markProcessed(messageId: string, consumer: string): Promise<boolean>;
  /** Housekeeping: rows older than `cutoff` (redeliveries never take that long). */
  purgeBefore(cutoff: Date): Promise<number>;
}

export const PROCESSED_MESSAGES = Symbol('PROCESSED_MESSAGES');
