import { truncate } from '../../../shared/domain/text';
import type { VideoStatus } from './video-status';
import { isTerminalStatus } from './video-status';

/** Column limits of `videos` / `video_status_history` (contratos.md, section 5). */
export const ERROR_MESSAGE_MAX_LENGTH = 500;
export const HISTORY_REASON_MAX_LENGTH = 200;

/** Every persisted field of a video (one row of `videos`). */
export interface VideoSnapshot {
  id: string;
  userId: string;
  originalName: string;
  sizeBytes: number;
  contentType: string | null;
  rawKey: string;
  zipKey: string | null;
  status: VideoStatus;
  attempts: number;
  frameCount: number | null;
  zipSizeBytes: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  /** Zip removed by the retention job (LGPD, section 12); downloads answer 410 V0006. */
  expiredAt: Date | null;
}

/** One row of `video_status_history`. */
export interface StatusTransition {
  from: VideoStatus | null;
  to: VideoStatus;
  reason: string;
}

export interface NewVideo {
  id: string;
  userId: string;
  originalName: string;
  sizeBytes: number;
  contentType: string | null;
  rawKey: string;
  idempotencyKey: string | null;
}

export interface ProcessingResult {
  zipKey: string;
  frameCount: number;
  zipSizeBytes: number;
}

export interface ProcessingFailure {
  errorCode: string;
  errorMessage: string;
}

/**
 * Video aggregate and owner of the state machine (contratos.md, section 3):
 *
 * ```
 * QUEUED ──started──► PROCESSING ──completed──► COMPLETED (terminal)
 *    │                    │   ▲
 *    │                    │   └── started (retry, attempt+1)
 *    │                    └──failed──► FAILED (terminal)
 *    └──── dead-letter (P0099) ───────► FAILED
 * ```
 *
 * Invalid transitions (late or duplicated events) return `null` and change nothing: the
 * consumer logs and acks. `completed`/`failed` are also accepted from QUEUED because the
 * `started` event of the same attempt may be consumed after them (prefetch 10).
 */
export class Video {
  private constructor(private props: VideoSnapshot) {}

  /** New upload, persisted as QUEUED together with its first history row. */
  static queue(input: NewVideo, at: Date): { video: Video; transition: StatusTransition } {
    const video = new Video({
      ...input,
      zipKey: null,
      status: 'QUEUED',
      attempts: 0,
      frameCount: null,
      zipSizeBytes: null,
      errorCode: null,
      errorMessage: null,
      createdAt: at,
      updatedAt: at,
      startedAt: null,
      completedAt: null,
      expiredAt: null,
    });
    return { video, transition: { from: null, to: 'QUEUED', reason: 'Upload recebido' } };
  }

  static restore(snapshot: VideoSnapshot): Video {
    return new Video({ ...snapshot });
  }

  get id(): string {
    return this.props.id;
  }

  get userId(): string {
    return this.props.userId;
  }

  get status(): VideoStatus {
    return this.props.status;
  }

  get originalName(): string {
    return this.props.originalName;
  }

  get rawKey(): string {
    return this.props.rawKey;
  }

  get zipKey(): string | null {
    return this.props.zipKey;
  }

  get frameCount(): number | null {
    return this.props.frameCount;
  }

  get errorCode(): string | null {
    return this.props.errorCode;
  }

  get errorMessage(): string | null {
    return this.props.errorMessage;
  }

  get expiredAt(): Date | null {
    return this.props.expiredAt;
  }

  get isTerminal(): boolean {
    return isTerminalStatus(this.props.status);
  }

  /** The zip can be downloaded: COMPLETED, with a zip key and not expired. */
  get isDownloadable(): boolean {
    return (
      this.props.status === 'COMPLETED' &&
      this.props.zipKey !== null &&
      this.props.expiredAt === null
    );
  }

  toSnapshot(): VideoSnapshot {
    return { ...this.props };
  }

  /** `video.processing.started`: first attempt (QUEUED) or a newer retry attempt (PROCESSING). */
  start(attempt: number, at: Date): StatusTransition | null {
    const { status, attempts } = this.props;
    if (status === 'QUEUED') {
      this.props = {
        ...this.props,
        status: 'PROCESSING',
        attempts: Math.max(attempts, attempt),
        startedAt: this.props.startedAt ?? at,
        updatedAt: at,
      };
      return {
        from: 'QUEUED',
        to: 'PROCESSING',
        reason: `Processamento iniciado (tentativa ${attempt})`,
      };
    }
    if (status === 'PROCESSING' && attempt > attempts) {
      this.props = { ...this.props, attempts: attempt, updatedAt: at };
      return {
        from: 'PROCESSING',
        to: 'PROCESSING',
        reason: `Nova tentativa de processamento (tentativa ${attempt})`,
      };
    }
    return null;
  }

  /** `video.processing.completed`. */
  complete(result: ProcessingResult, at: Date): StatusTransition | null {
    if (this.isTerminal) return null;
    const from = this.props.status;
    this.props = {
      ...this.props,
      status: 'COMPLETED',
      zipKey: result.zipKey,
      frameCount: result.frameCount,
      zipSizeBytes: result.zipSizeBytes,
      attempts: Math.max(this.props.attempts, 1),
      completedAt: at,
      updatedAt: at,
    };
    return {
      from,
      to: 'COMPLETED',
      reason: truncate(
        `Processamento concluído (${result.frameCount} frames)`,
        HISTORY_REASON_MAX_LENGTH,
      ),
    };
  }

  /** `video.processing.failed` (worker) or dead-letter (`P0099`, `reason` from the caller). */
  fail(
    failure: ProcessingFailure,
    at: Date,
    attempt?: number,
    reason?: string,
  ): StatusTransition | null {
    if (this.isTerminal) return null;
    const from = this.props.status;
    this.props = {
      ...this.props,
      status: 'FAILED',
      errorCode: failure.errorCode,
      errorMessage: truncate(failure.errorMessage, ERROR_MESSAGE_MAX_LENGTH),
      attempts: Math.max(this.props.attempts, attempt ?? 0),
      completedAt: at,
      updatedAt: at,
    };
    return {
      from,
      to: 'FAILED',
      reason: truncate(
        reason ?? `Falha no processamento (${failure.errorCode})`,
        HISTORY_REASON_MAX_LENGTH,
      ),
    };
  }

  /**
   * Retention (LGPD): the zip was deleted from the storage. The video stays COMPLETED (history
   * and metadata remain) but can no longer be downloaded.
   */
  expireZip(at: Date): void {
    this.props = { ...this.props, zipKey: null, expiredAt: at, updatedAt: at };
  }
}
