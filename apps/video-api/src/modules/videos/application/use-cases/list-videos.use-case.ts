import { Inject, Injectable } from '@nestjs/common';
import type { VideoRepository } from '../../domain/video.repository';
import { VIDEO_REPOSITORY } from '../../domain/video.repository';
import type { VideoStatus } from '../../domain/video-status';
import type { VideoListView } from '../video.view';
import { toVideoView } from '../video.view';

export interface ListVideosInput {
  userId: string;
  status?: VideoStatus;
  page: number;
  limit: number;
}

/** `GET /api/videos?page=&limit=&status=`: only the user's own videos, newest first. */
@Injectable()
export class ListVideosUseCase {
  constructor(@Inject(VIDEO_REPOSITORY) private readonly videos: VideoRepository) {}

  async execute(input: ListVideosInput): Promise<VideoListView> {
    const { items, total } = await this.videos.listByOwner(input);
    return { items: items.map(toVideoView), total, page: input.page, limit: input.limit };
  }
}
