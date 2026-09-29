import type { Video } from '../domain/video';
import type { HistoryEntry } from '../domain/video.repository';
import type { VideoStatus } from '../domain/video-status';

/** Item of `GET /api/videos` (only the user's own videos). Storage keys are never exposed. */
export interface VideoView {
  id: string;
  originalName: string;
  sizeBytes: number;
  contentType: string | null;
  status: VideoStatus;
  attempts: number;
  frameCount: number | null;
  zipSizeBytes: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Zip removed by the retention policy (LGPD): the download answers 410 V0006. */
  expiredAt: string | null;
  downloadAvailable: boolean;
}

export interface HistoryView {
  fromStatus: VideoStatus | null;
  toStatus: VideoStatus;
  reason: string | null;
  createdAt: string;
}

/** `GET /api/videos/:id`. */
export interface VideoDetailView extends VideoView {
  history: HistoryView[];
}

export interface VideoListView {
  items: VideoView[];
  total: number;
  page: number;
  limit: number;
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toVideoView(video: Video): VideoView {
  const v = video.toSnapshot();
  return {
    id: v.id,
    originalName: v.originalName,
    sizeBytes: v.sizeBytes,
    contentType: v.contentType,
    status: v.status,
    attempts: v.attempts,
    frameCount: v.frameCount,
    zipSizeBytes: v.zipSizeBytes,
    errorCode: v.errorCode,
    errorMessage: v.errorMessage,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
    startedAt: iso(v.startedAt),
    completedAt: iso(v.completedAt),
    expiredAt: iso(v.expiredAt),
    downloadAvailable: video.isDownloadable,
  };
}

export function toHistoryView(entry: HistoryEntry): HistoryView {
  return {
    fromStatus: entry.fromStatus,
    toStatus: entry.toStatus,
    reason: entry.reason,
    createdAt: entry.createdAt.toISOString(),
  };
}
