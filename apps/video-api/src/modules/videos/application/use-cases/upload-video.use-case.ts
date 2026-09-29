import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { AuthErrors, CommonErrors, VideoErrors } from '@fiapx/common';
import { createEvent } from '@fiapx/contracts';
import type { IObjectStorage, StorageBuckets } from '@fiapx/storage';
import {
  OBJECT_STORAGE,
  ObjectStorageError,
  rawVideoKey,
  STORAGE_BUCKETS,
  StorageQuotaExceededError,
  zipKey,
} from '@fiapx/storage';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Clock } from '../../../../shared/domain/clock';
import { CLOCK } from '../../../../shared/domain/clock';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work';
import { UNIT_OF_WORK } from '../../../../shared/application/unit-of-work';
import { Video } from '../../domain/video';
import {
  ALLOWED_EXTENSIONS,
  containerMatchesExtension,
  extensionOf,
  isAllowedExtension,
  sanitizeOriginalName,
} from '../../domain/video-file.policy';
import type { VideoRepository } from '../../domain/video.repository';
import {
  DuplicateIdempotencyKeyError,
  VIDEO_REPOSITORY,
  VideoOwnerNotFoundError,
} from '../../domain/video.repository';
import type { VideoStatus } from '../../domain/video-status';
import type { FileSignatureInspector } from '../ports/file-signature.inspector';
import { FILE_SIGNATURE_INSPECTOR } from '../ports/file-signature.inspector';
import type { IdempotencyCache } from '../ports/idempotency.cache';
import { IDEMPOTENCY_CACHE } from '../ports/idempotency.cache';
import type { VideoMetrics } from '../ports/video.metrics';
import { VIDEO_METRICS } from '../ports/video.metrics';
import type { VideoSettings } from '../video.settings';
import { VIDEO_SETTINGS } from '../video.settings';

/** Seconds suggested in `Retry-After` when the storage is down. */
export const STORAGE_RETRY_AFTER_SECONDS = 5;
/** `Retry-After` when `fiapx-raw` hit its quota: space comes back as the queue drains. */
export const RAW_BUCKET_FULL_RETRY_AFTER_SECONDS = 30;
/** `Retry-After` of `429 V0007`: a short video is processed in about 10 s. */
export const PENDING_VIDEOS_RETRY_AFTER_SECONDS = 15;

export interface IncomingVideoFile {
  /** File name sent by the client (sanitized here, never used as a storage key). */
  originalName: string;
  stream: Readable;
}

export interface UploadVideoInput {
  userId: string;
  correlationId: string;
  idempotencyKey?: string;
  file: IncomingVideoFile;
  /** Aborted when the client disconnects (the partial multipart upload is discarded). */
  signal?: AbortSignal;
}

/** `202 {id, originalName, status}`. */
export interface UploadAccepted {
  id: string;
  originalName: string;
  status: VideoStatus;
}

/**
 * `POST /api/videos` (contratos.md, section 8): extension + magic bytes → streaming PUT to
 * `fiapx-raw` → ONE transaction with the video (QUEUED), its first history row and the outbox
 * `video.uploaded` → 202. The broker is not touched here: with RabbitMQ down uploads are still
 * accepted and the outbox relay publishes later.
 */
@Injectable()
export class UploadVideoUseCase {
  private readonly logger = new Logger(UploadVideoUseCase.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(VIDEO_REPOSITORY) private readonly videos: VideoRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: IObjectStorage,
    @Inject(STORAGE_BUCKETS) private readonly buckets: StorageBuckets,
    @Inject(FILE_SIGNATURE_INSPECTOR) private readonly inspector: FileSignatureInspector,
    @Inject(IDEMPOTENCY_CACHE) private readonly idempotency: IdempotencyCache,
    @Inject(VIDEO_METRICS) private readonly metrics: VideoMetrics,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(VIDEO_SETTINGS) private readonly settings: VideoSettings,
  ) {}

  /**
   * Per-user limit of videos in progress (checked BEFORE reading the body): the ones in the
   * database (QUEUED/PROCESSING) plus `inFlight` uploads of this user still streaming.
   * @throws `429 V0007` with `Retry-After`
   */
  async assertWithinPendingLimit(userId: string, inFlight: number): Promise<void> {
    const limit = this.settings.maxPendingVideosPerUser;
    const pending = await this.videos.countPendingByOwner(userId);
    if (pending + inFlight < limit) return;
    this.logger.warn({ msg: 'Limite de vídeos em andamento atingido', userId, pending, inFlight });
    throw VideoErrors.TOO_MANY_PENDING_VIDEOS(limit, PENDING_VIDEOS_RETRY_AFTER_SECONDS);
  }

  /**
   * Upload already accepted with this `Idempotency-Key` (checked BEFORE reading the body):
   * Redis first, then the unique index `(user_id, idempotency_key)`.
   */
  async findReplay(userId: string, idempotencyKey: string): Promise<UploadAccepted | null> {
    const cachedId = await this.idempotency.get(userId, idempotencyKey);
    const cached = cachedId ? await this.videos.findOwnedBy(cachedId, userId) : null;
    const video = cached ?? (await this.videos.findByIdempotencyKey(userId, idempotencyKey));
    return video ? accepted(video) : null;
  }

  async execute(input: UploadVideoInput): Promise<UploadAccepted> {
    const originalName = sanitizeOriginalName(input.file.originalName);
    const extension = extensionOf(originalName);
    if (!isAllowedExtension(extension)) throw VideoErrors.UNSUPPORTED_FORMAT(ALLOWED_EXTENSIONS);

    const { detected, stream } = await this.inspector.inspect(input.file.stream);
    if (!containerMatchesExtension(extension, detected?.container)) {
      stream.destroy();
      throw VideoErrors.UNSUPPORTED_FORMAT(ALLOWED_EXTENSIONS);
    }

    const videoId = randomUUID();
    const rawKey = rawVideoKey(input.userId, videoId, extension);
    const { sizeBytes } = await this.putRaw(rawKey, stream, detected?.mime, videoId, input.signal);

    const now = this.clock.now();
    const { video, transition } = Video.queue(
      {
        id: videoId,
        userId: input.userId,
        originalName,
        sizeBytes,
        contentType: detected?.mime ?? null,
        rawKey,
        idempotencyKey: input.idempotencyKey ?? null,
      },
      now,
    );

    try {
      await this.uow.run(async (tx) => {
        await tx.videos.insert(video);
        await tx.videos.appendHistory(video.id, transition, now);
        await tx.outbox.add(
          createEvent(
            'video.uploaded',
            {
              videoId,
              userId: input.userId,
              originalName,
              rawBucket: this.buckets.raw,
              rawKey,
              zipBucket: this.buckets.zips,
              zipKey: zipKey(input.userId, videoId),
              sizeBytes,
            },
            input.correlationId,
          ),
          videoId,
        );
      });
    } catch (error) {
      // Never a 202 without a commit: the stored object would be an orphan.
      await this.deleteQuietly(rawKey);
      return this.recoverFromInsertFailure(error, input);
    }

    if (input.idempotencyKey) {
      await this.idempotency.remember(input.userId, input.idempotencyKey, videoId);
    }
    this.metrics.uploaded();
    this.logger.log({ msg: 'Vídeo aceito', videoId, userId: input.userId, sizeBytes });
    return accepted(video);
  }

  private async putRaw(
    key: string,
    body: Readable,
    contentType: string | undefined,
    videoId: string,
    signal: AbortSignal | undefined,
  ): Promise<{ sizeBytes: number }> {
    try {
      return await this.storage.putStream({
        bucket: this.buckets.raw,
        key,
        body,
        contentType,
        metadata: { 'video-id': videoId },
        signal,
      });
    } catch (error) {
      // Aborted by the HTTP layer (size limit, client gone): it decides the response.
      if (signal?.aborted) throw error;
      if (error instanceof StorageQuotaExceededError) {
        this.logger.warn({ msg: 'Bucket de vídeos originais cheio (quota)', videoId });
        throw CommonErrors.UNAVAILABLE(RAW_BUCKET_FULL_RETRY_AFTER_SECONDS);
      }
      if (error instanceof ObjectStorageError) {
        this.logger.warn({ msg: 'Storage indisponível no upload', videoId, error: error.message });
        throw CommonErrors.UNAVAILABLE(STORAGE_RETRY_AFTER_SECONDS);
      }
      throw error;
    }
  }

  private async recoverFromInsertFailure(
    error: unknown,
    input: UploadVideoInput,
  ): Promise<UploadAccepted> {
    if (error instanceof DuplicateIdempotencyKeyError && input.idempotencyKey) {
      // Concurrent retry with the same key won the race: answer with the video it created.
      const existing = await this.videos.findByIdempotencyKey(input.userId, input.idempotencyKey);
      if (existing) return accepted(existing);
    }
    if (error instanceof VideoOwnerNotFoundError) throw AuthErrors.UNAUTHORIZED();
    throw error;
  }

  private async deleteQuietly(key: string): Promise<void> {
    try {
      await this.storage.delete(this.buckets.raw, key);
    } catch (error) {
      this.logger.warn({
        msg: 'Falha ao apagar objeto órfão do upload',
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function accepted(video: Video): UploadAccepted {
  return { id: video.id, originalName: video.originalName, status: video.status };
}
