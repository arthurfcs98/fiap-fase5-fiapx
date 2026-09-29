import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { VideoStatus } from '../../domain/video-status';
import { VIDEO_STATUSES } from '../../domain/video-status';

/** `video_status_history` table (contratos.md, section 5). */
@Entity({ name: 'video_status_history' })
export class VideoStatusHistoryOrmEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'video_id', type: 'uuid' })
  videoId!: string;

  @Column({
    name: 'from_status',
    type: 'enum',
    enum: [...VIDEO_STATUSES],
    enumName: 'video_status',
    nullable: true,
  })
  fromStatus!: VideoStatus | null;

  @Column({ name: 'to_status', type: 'enum', enum: [...VIDEO_STATUSES], enumName: 'video_status' })
  toStatus!: VideoStatus;

  @Column({ type: 'varchar', length: 200, nullable: true })
  reason!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
