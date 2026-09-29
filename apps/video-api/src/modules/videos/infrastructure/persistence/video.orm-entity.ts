import { Column, Entity, PrimaryColumn } from 'typeorm';
import { bigintToNumber } from '../../../../shared/infrastructure/database/transformers';
import type { VideoStatus } from '../../domain/video-status';
import { VIDEO_STATUSES } from '../../domain/video-status';

/** `videos` table (contratos.md, sections 5 and 12). The schema comes only from the migrations. */
@Entity({ name: 'videos' })
export class VideoOrmEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'original_name', type: 'varchar', length: 255 })
  originalName!: string;

  @Column({ name: 'size_bytes', type: 'bigint', transformer: bigintToNumber })
  sizeBytes!: number;

  @Column({ name: 'content_type', type: 'varchar', length: 100, nullable: true })
  contentType!: string | null;

  @Column({ name: 'raw_key', type: 'varchar', length: 300 })
  rawKey!: string;

  @Column({ name: 'zip_key', type: 'varchar', length: 300, nullable: true })
  zipKey!: string | null;

  @Column({ type: 'enum', enum: [...VIDEO_STATUSES], enumName: 'video_status' })
  status!: VideoStatus;

  @Column({ type: 'int' })
  attempts!: number;

  @Column({ name: 'frame_count', type: 'int', nullable: true })
  frameCount!: number | null;

  @Column({ name: 'zip_size_bytes', type: 'bigint', nullable: true, transformer: bigintToNumber })
  zipSizeBytes!: number | null;

  @Column({ name: 'error_code', type: 'varchar', length: 10, nullable: true })
  errorCode!: string | null;

  @Column({ name: 'error_message', type: 'varchar', length: 500, nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 100, nullable: true })
  idempotencyKey!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ name: 'expired_at', type: 'timestamptz', nullable: true })
  expiredAt!: Date | null;
}
