import { AuthErrors } from '@fiapx/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Clock } from '../../../../shared/domain/clock';
import { CLOCK } from '../../../../shared/domain/clock';
import type { UserRepository } from '../../../auth/domain/user.repository';
import { USER_REPOSITORY } from '../../../auth/domain/user.repository';
import type { HistoryView, VideoView } from '../../../videos/application/video.view';
import { toHistoryView, toVideoView } from '../../../videos/application/video.view';
import type { VideoRepository } from '../../../videos/domain/video.repository';
import { VIDEO_REPOSITORY } from '../../../videos/domain/video.repository';

export interface MyDataExport {
  exportedAt: string;
  user: {
    id: string;
    name: string;
    email: string;
    createdAt: string;
    updatedAt: string;
    privacyAcceptedAt: string;
    privacyPolicyVersion: string;
  };
  videos: (VideoView & { history: HistoryView[] })[];
}

/**
 * `GET /api/me/data` — access and portability (LGPD art. 18 II and V, contratos.md section 12):
 * everything stored about the user, as JSON (never the password hash).
 */
@Injectable()
export class ExportMyDataUseCase {
  private readonly logger = new Logger(ExportMyDataUseCase.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(VIDEO_REPOSITORY) private readonly videos: VideoRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(userId: string): Promise<MyDataExport> {
    const user = await this.users.findById(userId);
    if (!user) throw AuthErrors.UNAUTHORIZED();
    const videos = await this.videos.listAllByOwner(userId);
    const history = await this.videos.historyOf(videos.map((video) => video.id));

    this.logger.log({ msg: 'Exportação de dados pessoais (LGPD)', userId, videos: videos.length });
    return {
      exportedAt: this.clock.now().toISOString(),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
        privacyAcceptedAt: user.privacyAcceptedAt.toISOString(),
        privacyPolicyVersion: user.privacyPolicyVersion,
      },
      videos: videos.map((video) => ({
        ...toVideoView(video),
        history: history.filter((entry) => entry.videoId === video.id).map(toHistoryView),
      })),
    };
  }
}
