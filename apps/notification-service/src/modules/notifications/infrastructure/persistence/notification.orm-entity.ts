import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * TypeORM mapping of `notifications` (contratos.md, sections 6 and 12). The table is created
 * only by the migration (`synchronize: false`); these decorators just map columns.
 */
@Entity({ name: 'notifications' })
export class NotificationOrmEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'dedup_key', type: 'varchar', length: 200, unique: true })
  dedupKey!: string;

  @Index('ix_notifications_user')
  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 40 })
  type!: string;

  @Column({ type: 'varchar', length: 255 })
  recipient!: string;

  @Column({ type: 'varchar', length: 255 })
  subject!: string;

  @Column({ type: 'varchar', length: 20, default: 'PENDING' })
  status!: string;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ name: 'provider_message_id', type: 'varchar', length: 100, nullable: true })
  providerMessageId!: string | null;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError!: string | null;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt!: Date | null;
}
