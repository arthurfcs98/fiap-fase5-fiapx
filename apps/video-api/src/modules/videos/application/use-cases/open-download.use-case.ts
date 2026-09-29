import type { Readable } from 'node:stream';
import { CommonErrors, VideoErrors } from '@fiapx/common';
import type { IObjectStorage, StorageBuckets } from '@fiapx/storage';
import { OBJECT_STORAGE, ObjectNotFoundError, STORAGE_BUCKETS } from '@fiapx/storage';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Clock } from '../../../../shared/domain/clock';
import { CLOCK } from '../../../../shared/domain/clock';
import { isUuid } from '../../../../shared/domain/uuid';
import type { VideoRepository } from '../../domain/video.repository';
import { VIDEO_REPOSITORY } from '../../domain/video.repository';
import type { DownloadSigner } from '../ports/download.signer';
import { DOWNLOAD_SIGNER } from '../ports/download.signer';
import { STORAGE_RETRY_AFTER_SECONDS } from './upload-video.use-case';

export interface DownloadRequest {
  videoId: string;
  /** Raw query values (`?exp=&sig=`). */
  expires: unknown;
  signature: unknown;
}

export interface ZipDownload {
  body: Readable;
  sizeBytes: number;
  /** `<original name without extension>_frames.zip`. */
  fileName: string;
}

/**
 * `GET /api/downloads/:id?exp=&sig=` (no Bearer: the HMAC is the credential). Invalid or expired
 * signature → 403 V0005; zip removed by the retention → 410 V0006. The zip is streamed from the
 * storage, never buffered.
 */
@Injectable()
export class OpenDownloadUseCase {
  private readonly logger = new Logger(OpenDownloadUseCase.name);

  constructor(
    @Inject(VIDEO_REPOSITORY) private readonly videos: VideoRepository,
    @Inject(DOWNLOAD_SIGNER) private readonly signer: DownloadSigner,
    @Inject(OBJECT_STORAGE) private readonly storage: IObjectStorage,
    @Inject(STORAGE_BUCKETS) private readonly buckets: StorageBuckets,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(request: DownloadRequest): Promise<ZipDownload> {
    if (!this.hasValidSignature(request)) throw VideoErrors.INVALID_DOWNLOAD_SIGNATURE();

    const video = await this.videos.findById(request.videoId);
    if (!video) throw VideoErrors.NOT_FOUND(request.videoId);
    if (video.expiredAt) throw VideoErrors.ZIP_EXPIRED(video.id);
    if (!video.isDownloadable || !video.zipKey) {
      throw VideoErrors.NOT_READY(video.id, video.status);
    }

    try {
      const object = await this.storage.getStream(this.buckets.zips, video.zipKey);
      this.logger.log({ msg: 'Download do zip iniciado', videoId: video.id, userId: video.userId });
      return {
        body: object.body,
        sizeBytes: object.sizeBytes,
        fileName: zipFileName(video.originalName),
      };
    } catch (error) {
      // Row still points to a zip that is gone (retention raced with this request).
      if (error instanceof ObjectNotFoundError) throw VideoErrors.ZIP_EXPIRED(video.id);
      this.logger.warn({
        msg: 'Storage indisponível no download',
        videoId: video.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw CommonErrors.UNAVAILABLE(STORAGE_RETRY_AFTER_SECONDS);
    }
  }

  private hasValidSignature({ videoId, expires, signature }: DownloadRequest): boolean {
    if (!isUuid(videoId) || typeof signature !== 'string' || typeof expires !== 'string') {
      return false;
    }
    if (!/^\d{1,12}$/.test(expires)) return false;
    const expiresAt = Number(expires);
    if (expiresAt * 1000 < this.clock.now().getTime()) return false;
    return this.signer.verify(videoId, expiresAt, signature);
  }
}

/** `demo.mp4` → `demo_frames.zip`. */
export function zipFileName(originalName: string): string {
  const dot = originalName.lastIndexOf('.');
  const base = dot > 0 ? originalName.slice(0, dot) : originalName;
  return `${base || 'video'}_frames.zip`;
}
