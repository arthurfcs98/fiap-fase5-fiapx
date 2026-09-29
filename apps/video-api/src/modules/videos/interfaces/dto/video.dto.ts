import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';
import { VIDEO_STATUSES } from '../../domain/video-status';

/** `GET /api/videos?page=1&limit=20&status=`. */
export const listVideosQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(VIDEO_STATUSES).optional(),
});

export type ListVideosQuery = z.output<typeof listVideosQuerySchema>;

/** `Idempotency-Key` accepted from the client (fits `videos.idempotency_key varchar(100)`). */
export const idempotencyKeySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9._:-]{1,100}$/,
    'Idempotency-Key deve ter de 1 a 100 caracteres [A-Za-z0-9._:-] (ex.: um UUID).',
  );

export class UploadAcceptedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'demo.mp4' })
  originalName!: string;

  @ApiProperty({ enum: VIDEO_STATUSES, example: 'QUEUED' })
  status!: string;
}

export class VideoDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'demo.mp4' })
  originalName!: string;

  @ApiProperty({ example: 10485760 })
  sizeBytes!: number;

  @ApiPropertyOptional({ example: 'video/mp4', nullable: true, type: String })
  contentType!: string | null;

  @ApiProperty({ enum: VIDEO_STATUSES })
  status!: string;

  @ApiProperty({ example: 1, description: 'Tentativas de processamento' })
  attempts!: number;

  @ApiPropertyOptional({ example: 42, nullable: true, type: Number })
  frameCount!: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  zipSizeBytes!: number | null;

  @ApiPropertyOptional({ example: 'P0001', nullable: true, type: String })
  errorCode!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  errorMessage!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiPropertyOptional({ format: 'date-time', nullable: true, type: String })
  startedAt!: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true, type: String })
  completedAt!: string | null;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'Zip removido pela retenção (LGPD): download → 410 V0006',
  })
  expiredAt!: string | null;

  @ApiProperty({ description: 'COMPLETED, com zip disponível' })
  downloadAvailable!: boolean;
}

export class HistoryDto {
  @ApiPropertyOptional({ enum: VIDEO_STATUSES, nullable: true, type: String })
  fromStatus!: string | null;

  @ApiProperty({ enum: VIDEO_STATUSES })
  toStatus!: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  reason!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class VideoDetailDto extends VideoDto {
  @ApiProperty({ type: [HistoryDto] })
  history!: HistoryDto[];
}

export class VideoListDto {
  @ApiProperty({ type: [VideoDto] })
  items!: VideoDto[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;
}

export class DownloadUrlDto {
  @ApiProperty({ example: 'https://fiapx.asdevit.com/api/downloads/<id>?exp=1790000000&sig=...' })
  url!: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
}
