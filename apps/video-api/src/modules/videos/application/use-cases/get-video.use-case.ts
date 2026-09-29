import { VideoErrors } from '@fiapx/common';
import { Inject, Injectable } from '@nestjs/common';
import { isUuid } from '../../../../shared/domain/uuid';
import type { VideoRepository } from '../../domain/video.repository';
import { VIDEO_REPOSITORY } from '../../domain/video.repository';
import type { VideoDetailView } from '../video.view';
import { toHistoryView, toVideoView } from '../video.view';

/** `GET /api/videos/:id`: detail + history. Another user's video → 404 V0001 (no enumeration). */
@Injectable()
export class GetVideoUseCase {
  constructor(@Inject(VIDEO_REPOSITORY) private readonly videos: VideoRepository) {}

  async execute(userId: string, videoId: string): Promise<VideoDetailView> {
    const video = isUuid(videoId) ? await this.videos.findOwnedBy(videoId, userId) : null;
    if (!video) throw VideoErrors.NOT_FOUND(videoId);
    const history = await this.videos.historyOf([video.id]);
    return { ...toVideoView(video), history: history.map(toHistoryView) };
  }
}
