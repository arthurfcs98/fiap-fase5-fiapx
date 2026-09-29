import { METRICS_REGISTRY } from '@fiapx/observability';
import { Module } from '@nestjs/common';
import type { Registry } from '@prometheus-io/client';
import type Redis from 'ioredis';
import type { ApiConfig } from '../../config/api.config';
import { API_CONFIG } from '../../config/api.config';
import { REDIS_CLIENT } from '../../shared/infrastructure/redis/redis.constants';
import { DOWNLOAD_SIGNER } from './application/ports/download.signer';
import { FILE_SIGNATURE_INSPECTOR } from './application/ports/file-signature.inspector';
import { IDEMPOTENCY_CACHE } from './application/ports/idempotency.cache';
import { VIDEO_METRICS } from './application/ports/video.metrics';
import { RawVideoCleanup } from './application/raw-video.cleanup';
import { ApplyProcessingEventUseCase } from './application/use-cases/apply-processing-event.use-case';
import { CreateDownloadUrlUseCase } from './application/use-cases/create-download-url.use-case';
import { ExpireZipsUseCase } from './application/use-cases/expire-zips.use-case';
import { GetVideoUseCase } from './application/use-cases/get-video.use-case';
import { HandleDeadLetterUseCase } from './application/use-cases/handle-dead-letter.use-case';
import { ListVideosUseCase } from './application/use-cases/list-videos.use-case';
import { OpenDownloadUseCase } from './application/use-cases/open-download.use-case';
import { UploadVideoUseCase } from './application/use-cases/upload-video.use-case';
import { VIDEO_SETTINGS, videoSettingsFromConfig } from './application/video.settings';
import { FileTypeSignatureInspector } from './infrastructure/file-signature/file-type-signature.inspector';
import { RedisIdempotencyCache } from './infrastructure/idempotency/redis-idempotency.cache';
import { PrometheusVideoMetrics } from './infrastructure/metrics/prometheus-video.metrics';
import { HmacDownloadSigner } from './infrastructure/signing/hmac-download.signer';
import { VideoDeadLetterConsumer } from './interfaces/consumers/video-dead-letter.consumer';
import { VideoProcessingConsumer } from './interfaces/consumers/video-processing.consumer';
import { DownloadsController } from './interfaces/controllers/downloads.controller';
import { VideosController } from './interfaces/controllers/videos.controller';

/**
 * Videos: upload, listing, detail, signed download, the consumers of the processing results
 * (owner of the state machine) and the zip retention. Persistence, storage, messaging, Redis
 * and `METRICS_REGISTRY` come from the global modules.
 */
@Module({
  controllers: [VideosController, DownloadsController],
  providers: [
    {
      provide: VIDEO_SETTINGS,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => videoSettingsFromConfig(config),
    },
    {
      provide: DOWNLOAD_SIGNER,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => new HmacDownloadSigner(config.DOWNLOAD_URL_SECRET),
    },
    { provide: FILE_SIGNATURE_INSPECTOR, useClass: FileTypeSignatureInspector },
    {
      provide: IDEMPOTENCY_CACHE,
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis) => new RedisIdempotencyCache(redis),
    },
    {
      provide: VIDEO_METRICS,
      inject: [METRICS_REGISTRY],
      useFactory: (registry: Registry) => new PrometheusVideoMetrics(registry),
    },
    RawVideoCleanup,
    UploadVideoUseCase,
    ListVideosUseCase,
    GetVideoUseCase,
    CreateDownloadUrlUseCase,
    OpenDownloadUseCase,
    ApplyProcessingEventUseCase,
    HandleDeadLetterUseCase,
    ExpireZipsUseCase,
    VideoProcessingConsumer,
    VideoDeadLetterConsumer,
  ],
  exports: [ExpireZipsUseCase],
})
export class VideosModule {}
