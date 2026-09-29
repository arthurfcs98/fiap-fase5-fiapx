import { METRICS_REGISTRY } from '@fiapx/observability';
import { Module } from '@nestjs/common';
import type { Registry } from '@prometheus-io/client';
import type { WorkerConfig } from '../../config/worker.config';
import { WORKER_CONFIG } from '../../config/worker.config';
import {
  processingSettingsFromConfig,
  PROCESSING_SETTINGS,
} from './application/processing.settings';
import { ProcessVideoUseCase } from './application/use-cases/process-video.use-case';
import { ReportProcessingFailureUseCase } from './application/use-cases/report-processing-failure.use-case';
import { FRAME_ARCHIVER } from './domain/ports/frame-archiver.port';
import { PROCESSING_METRICS } from './domain/ports/processing-metrics.port';
import { VIDEO_TOOLKIT } from './domain/ports/video-toolkit.port';
import { WORK_DIRECTORY } from './domain/ports/work-directory.port';
import { FfmpegVideoToolkit } from './infrastructure/ffmpeg/ffmpeg-video-toolkit';
import { LocalWorkDirectory } from './infrastructure/filesystem/local-work-directory';
import { PrometheusProcessingMetrics } from './infrastructure/metrics/prometheus-processing-metrics';
import { ProcessRunner } from './infrastructure/process/process-runner';
import { ArchiverFrameArchiver } from './infrastructure/zip/archiver-frame-archiver';
import { VideoUploadedConsumer } from './interfaces/consumers/video-uploaded.consumer';
import { WorkDirectoryJanitor } from './interfaces/lifecycle/work-directory.janitor';

/**
 * Video processing: consumer of `worker.video-uploaded`, use cases and the adapters behind the
 * domain ports (ffprobe/ffmpeg CLI, archiver, local scratch disk, Prometheus). Storage
 * (`OBJECT_STORAGE`), messaging (`EVENT_PUBLISHER`, `MessageConsumers`) and `METRICS_REGISTRY`
 * come from the global modules of the root module.
 */
@Module({
  providers: [
    {
      provide: PROCESSING_SETTINGS,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => processingSettingsFromConfig(config),
    },
    ProcessRunner,
    {
      provide: VIDEO_TOOLKIT,
      inject: [ProcessRunner],
      useFactory: (runner: ProcessRunner) => new FfmpegVideoToolkit(runner),
    },
    { provide: FRAME_ARCHIVER, useClass: ArchiverFrameArchiver },
    {
      provide: WORK_DIRECTORY,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig) => new LocalWorkDirectory(config.WORK_DIR),
    },
    {
      provide: PROCESSING_METRICS,
      inject: [METRICS_REGISTRY],
      useFactory: (registry: Registry) => new PrometheusProcessingMetrics(registry),
    },
    ProcessVideoUseCase,
    ReportProcessingFailureUseCase,
    WorkDirectoryJanitor,
    VideoUploadedConsumer,
  ],
})
export class ProcessingModule {}
