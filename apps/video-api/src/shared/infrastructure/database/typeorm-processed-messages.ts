import type { EntityManager } from 'typeorm';
import type { ProcessedMessages } from '../../application/processed-messages';

/** `processed_messages` (inbox) adapter. */
export class TypeOrmProcessedMessages implements ProcessedMessages {
  constructor(private readonly manager: EntityManager) {}

  async markProcessed(messageId: string, consumer: string): Promise<boolean> {
    const rows = await this.manager.query<unknown[]>(
      `INSERT INTO processed_messages (message_id, consumer) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING message_id`,
      [messageId, consumer],
    );
    return rows.length === 1;
  }

  async purgeBefore(cutoff: Date): Promise<number> {
    const [, affected] = await this.manager.query<[unknown[], number]>(
      `DELETE FROM processed_messages WHERE processed_at < $1`,
      [cutoff],
    );
    return affected;
  }
}
