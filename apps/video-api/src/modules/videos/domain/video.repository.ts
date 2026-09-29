import type { StatusTransition, Video } from './video';
import type { VideoStatus } from './video-status';

export interface VideoListQuery {
  userId: string;
  status?: VideoStatus;
  /** 1-based. */
  page: number;
  limit: number;
}

export interface VideoPage {
  items: Video[];
  total: number;
}

/** One row of `video_status_history`. */
export interface HistoryEntry {
  videoId: string;
  fromStatus: VideoStatus | null;
  toStatus: VideoStatus;
  reason: string | null;
  createdAt: Date;
}

/**
 * Persistence port of `videos` + `video_status_history`. Every read by a user goes through an
 * owner filter (`findOwnedBy`, `listByOwner`): another user's video is "not found" (404).
 */
export interface VideoRepository {
  /**
   * @throws DuplicateIdempotencyKeyError same `(user_id, idempotency_key)` (concurrent retry)
   * @throws VideoOwnerNotFoundError the user was deleted while the upload was running
   */
  insert(video: Video): Promise<void>;
  update(video: Video): Promise<void>;
  findById(id: string): Promise<Video | null>;
  findOwnedBy(id: string, userId: string): Promise<Video | null>;
  findByIdempotencyKey(userId: string, idempotencyKey: string): Promise<Video | null>;
  /** `SELECT ... FOR UPDATE` (only inside a transaction). */
  lockById(id: string): Promise<Video | null>;
  /** Newest first. */
  listByOwner(query: VideoListQuery): Promise<VideoPage>;
  /** Every video of the user, newest first (data export). */
  listAllByOwner(userId: string): Promise<Video[]>;
  appendHistory(videoId: string, transition: StatusTransition, at: Date): Promise<void>;
  /** History of the given videos, oldest first. */
  historyOf(videoIds: readonly string[]): Promise<HistoryEntry[]>;
  /**
   * COMPLETED videos whose zip is still stored and that completed before `completedBefore`,
   * locked with `FOR UPDATE SKIP LOCKED` (retention job, inside a transaction).
   */
  lockExpiredZips(completedBefore: Date, limit: number): Promise<Video[]>;
  /** Deletes the history and the videos of the user; returns the deleted video ids. */
  deleteAllByOwner(userId: string): Promise<string[]>;
}

export const VIDEO_REPOSITORY = Symbol('VIDEO_REPOSITORY');

export class DuplicateIdempotencyKeyError extends Error {
  constructor() {
    super('Duplicate idempotency key');
    this.name = 'DuplicateIdempotencyKeyError';
  }
}

export class VideoOwnerNotFoundError extends Error {
  constructor() {
    super('Video owner no longer exists');
    this.name = 'VideoOwnerNotFoundError';
  }
}
