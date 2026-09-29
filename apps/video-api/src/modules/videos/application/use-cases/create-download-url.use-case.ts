import { VideoErrors } from '@fiapx/common';
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '../../../../shared/domain/clock';
import { CLOCK } from '../../../../shared/domain/clock';
import { isUuid } from '../../../../shared/domain/uuid';
import type { VideoRepository } from '../../domain/video.repository';
import { VIDEO_REPOSITORY } from '../../domain/video.repository';
import type { DownloadSigner } from '../ports/download.signer';
import { DOWNLOAD_SIGNER } from '../ports/download.signer';
import type { VideoSettings } from '../video.settings';
import { VIDEO_SETTINGS } from '../video.settings';

export interface DownloadUrl {
  url: string;
  expiresAt: string;
}

/**
 * `POST /api/videos/:id/download-url` (owner only): HMAC-signed link valid for 5 minutes.
 * Not ready → 409 V0004; zip removed by the retention → 410 V0006.
 */
@Injectable()
export class CreateDownloadUrlUseCase {
  constructor(
    @Inject(VIDEO_REPOSITORY) private readonly videos: VideoRepository,
    @Inject(DOWNLOAD_SIGNER) private readonly signer: DownloadSigner,
    @Inject(VIDEO_SETTINGS) private readonly settings: VideoSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(userId: string, videoId: string): Promise<DownloadUrl> {
    const video = isUuid(videoId) ? await this.videos.findOwnedBy(videoId, userId) : null;
    if (!video) throw VideoErrors.NOT_FOUND(videoId);
    if (video.expiredAt) throw VideoErrors.ZIP_EXPIRED(video.id);
    if (!video.isDownloadable) throw VideoErrors.NOT_READY(video.id, video.status);

    const expiresAt =
      Math.floor(this.clock.now().getTime() / 1000) + this.settings.downloadUrlTtlSeconds;
    const query = new URLSearchParams({
      exp: String(expiresAt),
      sig: this.signer.sign(video.id, expiresAt),
    });
    return {
      url: `${this.settings.publicBaseUrl}/api/downloads/${video.id}?${query.toString()}`,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    };
  }
}
