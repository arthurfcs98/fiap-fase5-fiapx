import type { EntityManager } from 'typeorm';
import { In } from 'typeorm';
import {
  isPgError,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
} from '../../../../shared/infrastructure/database/pg-errors';
import type { StatusTransition } from '../../domain/video';
import { Video } from '../../domain/video';
import type { VideoStatus } from '../../domain/video-status';
import type {
  HistoryEntry,
  VideoListQuery,
  VideoPage,
  VideoRepository,
} from '../../domain/video.repository';
import {
  DuplicateIdempotencyKeyError,
  VideoOwnerNotFoundError,
} from '../../domain/video.repository';
import { VideoStatusHistoryOrmEntity } from './video-status-history.orm-entity';
import { VideoOrmEntity } from './video.orm-entity';

/** Names Postgres gives to the constraints of `videos` (contratos.md, section 5). */
export const VIDEOS_IDEMPOTENCY_CONSTRAINT = 'videos_user_id_idempotency_key_key';
export const VIDEOS_USER_FK_CONSTRAINT = 'videos_user_id_fkey';

/** TypeORM adapter of {@link VideoRepository} (default manager or the transaction's one). */
export class TypeOrmVideoRepository implements VideoRepository {
  constructor(private readonly manager: EntityManager) {}

  private get videos() {
    return this.manager.getRepository(VideoOrmEntity);
  }

  private get history() {
    return this.manager.getRepository(VideoStatusHistoryOrmEntity);
  }

  async insert(video: Video): Promise<void> {
    try {
      await this.videos.insert(Object.assign(new VideoOrmEntity(), video.toSnapshot()));
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION, VIDEOS_IDEMPOTENCY_CONSTRAINT)) {
        throw new DuplicateIdempotencyKeyError();
      }
      if (isPgError(error, PG_FOREIGN_KEY_VIOLATION, VIDEOS_USER_FK_CONSTRAINT)) {
        throw new VideoOwnerNotFoundError();
      }
      throw error;
    }
  }

  async update(video: Video): Promise<void> {
    const { id, ...changes } = video.toSnapshot();
    await this.videos.update({ id }, changes);
  }

  async findById(id: string): Promise<Video | null> {
    return toDomain(await this.videos.findOne({ where: { id } }));
  }

  async findOwnedBy(id: string, userId: string): Promise<Video | null> {
    return toDomain(await this.videos.findOne({ where: { id, userId } }));
  }

  async findByIdempotencyKey(userId: string, idempotencyKey: string): Promise<Video | null> {
    return toDomain(await this.videos.findOne({ where: { userId, idempotencyKey } }));
  }

  async lockById(id: string): Promise<Video | null> {
    return toDomain(
      await this.videos.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } }),
    );
  }

  async listByOwner(query: VideoListQuery): Promise<VideoPage> {
    const [rows, total] = await this.videos.findAndCount({
      where: query.status
        ? { userId: query.userId, status: query.status }
        : { userId: query.userId },
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { items: rows.map(restore), total };
  }

  async listAllByOwner(userId: string): Promise<Video[]> {
    const rows = await this.videos.find({
      where: { userId },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return rows.map(restore);
  }

  async appendHistory(videoId: string, transition: StatusTransition, at: Date): Promise<void> {
    await this.history.insert({
      videoId,
      fromStatus: transition.from,
      toStatus: transition.to,
      reason: transition.reason,
      createdAt: at,
    });
  }

  async historyOf(videoIds: readonly string[]): Promise<HistoryEntry[]> {
    if (videoIds.length === 0) return [];
    const rows = await this.history.find({
      where: { videoId: In([...videoIds]) },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    return rows.map((row) => ({
      videoId: row.videoId,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      reason: row.reason,
      createdAt: row.createdAt,
    }));
  }

  async lockExpiredZips(completedBefore: Date, limit: number): Promise<Video[]> {
    const locked = await this.manager.query<{ id: string }[]>(
      `SELECT id FROM videos
        WHERE status = 'COMPLETED' AND zip_key IS NOT NULL AND expired_at IS NULL
          AND completed_at < $1
        ORDER BY completed_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [completedBefore, limit],
    );
    if (locked.length === 0) return [];
    const rows = await this.videos.find({
      where: { id: In(locked.map((row) => row.id)) },
      order: { completedAt: 'ASC' },
    });
    return rows.map(restore);
  }

  async countPendingByOwner(userId: string): Promise<number> {
    const rows = await this.manager.query<{ pending: number }[]>(
      `SELECT count(*)::int AS pending FROM videos
        WHERE user_id = $1 AND status IN ('QUEUED', 'PROCESSING')`,
      [userId],
    );
    return rows[0]?.pending ?? 0;
  }

  async statusesOf(ids: readonly string[]): Promise<Map<string, VideoStatus>> {
    if (ids.length === 0) return new Map();
    const rows = await this.manager.query<{ id: string; status: VideoStatus }[]>(
      `SELECT id, status FROM videos WHERE id = ANY($1::uuid[])`,
      [[...ids]],
    );
    return new Map(rows.map((row) => [row.id, row.status]));
  }

  async sumStoredZipBytes(): Promise<number> {
    const rows = await this.manager.query<{ bytes: string | number | null }[]>(
      `SELECT COALESCE(sum(zip_size_bytes), 0)::bigint AS bytes FROM videos
        WHERE zip_key IS NOT NULL AND expired_at IS NULL`,
    );
    return Number(rows[0]?.bytes ?? 0);
  }

  async deleteAllByOwner(userId: string): Promise<string[]> {
    const rows = await this.videos.find({ select: { id: true }, where: { userId } });
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return [];
    await this.history.delete({ videoId: In(ids) });
    await this.videos.delete({ userId });
    return ids;
  }
}

function restore(entity: VideoOrmEntity): Video {
  return Video.restore({
    id: entity.id,
    userId: entity.userId,
    originalName: entity.originalName,
    sizeBytes: entity.sizeBytes,
    contentType: entity.contentType,
    rawKey: entity.rawKey,
    zipKey: entity.zipKey,
    status: entity.status,
    attempts: entity.attempts,
    frameCount: entity.frameCount,
    zipSizeBytes: entity.zipSizeBytes,
    errorCode: entity.errorCode,
    errorMessage: entity.errorMessage,
    idempotencyKey: entity.idempotencyKey,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    startedAt: entity.startedAt,
    completedAt: entity.completedAt,
    expiredAt: entity.expiredAt,
  });
}

function toDomain(entity: VideoOrmEntity | null): Video | null {
  return entity ? restore(entity) : null;
}
