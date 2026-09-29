import type { IncomingMessage } from 'node:http';
import { CommonErrors, VideoErrors, ZodValidationPipe } from '@fiapx/common';
import { getCorrelationId } from '@fiapx/observability';
import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiGoneResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { ThrottleBy } from '../../../../shared/infrastructure/throttling/throttle';
import { BEARER_AUTH } from '../../../../shared/interfaces/http.constants';
import type { AuthenticatedUser } from '../../../auth/domain/user';
import { CurrentUser } from '../../../auth/interfaces/decorators/current-user.decorator';
import type { DownloadUrl } from '../../application/use-cases/create-download-url.use-case';
import { CreateDownloadUrlUseCase } from '../../application/use-cases/create-download-url.use-case';
import { GetVideoUseCase } from '../../application/use-cases/get-video.use-case';
import { ListVideosUseCase } from '../../application/use-cases/list-videos.use-case';
import type { UploadAccepted } from '../../application/use-cases/upload-video.use-case';
import { UploadVideoUseCase } from '../../application/use-cases/upload-video.use-case';
import type { VideoSettings } from '../../application/video.settings';
import { VIDEO_SETTINGS } from '../../application/video.settings';
import type { VideoDetailView, VideoListView } from '../../application/video.view';
import { ALLOWED_EXTENSIONS } from '../../domain/video-file.policy';
import type { UploadSlots } from '../http/upload-slots';
import { UPLOAD_BUSY_RETRY_AFTER_SECONDS, UPLOAD_SLOTS } from '../http/upload-slots';
import { VIDEO_STATUSES } from '../../domain/video-status';
import type { ListVideosQuery } from '../dto/video.dto';
import {
  DownloadUrlDto,
  idempotencyKeySchema,
  listVideosQuerySchema,
  UploadAcceptedDto,
  VideoDetailDto,
  VideoListDto,
} from '../dto/video.dto';
import {
  drainRequest,
  MULTIPART_OVERHEAD_BYTES,
  readMultipartFile,
  VIDEO_FIELD,
} from '../http/multipart-file.reader';

@ApiTags('videos')
@ApiBearerAuth(BEARER_AUTH)
@Controller('videos')
export class VideosController {
  constructor(
    private readonly uploadVideo: UploadVideoUseCase,
    private readonly listVideos: ListVideosUseCase,
    private readonly getVideo: GetVideoUseCase,
    private readonly createDownloadUrl: CreateDownloadUrlUseCase,
    @Inject(VIDEO_SETTINGS) private readonly settings: VideoSettings,
    @Inject(UPLOAD_SLOTS) private readonly slots: UploadSlots,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ThrottleBy('upload')
  @ApiOperation({
    summary: 'Upload de um vídeo (streaming direto para o storage)',
    description:
      `Campo multipart \`${VIDEO_FIELD}\`, um arquivo por requisição. Extensões: ` +
      `${ALLOWED_EXTENSIONS.join(' ')} (conferidas também pelos magic bytes). Repetir a ` +
      'requisição com o mesmo `Idempotency-Key` devolve o mesmo vídeo.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: [VIDEO_FIELD],
      properties: { [VIDEO_FIELD]: { type: 'string', format: 'binary' } },
    },
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Ex.: um UUID por arquivo' })
  @ApiAcceptedResponse({ type: UploadAcceptedDto })
  @ApiBadRequestResponse({ description: 'V0002 UNSUPPORTED_FORMAT · X0001 VALIDATION' })
  @ApiPayloadTooLargeResponse({ description: 'V0003 FILE_TOO_LARGE' })
  @ApiTooManyRequestsResponse({
    description: 'X0429 throttling · V0007 vídeos em andamento demais (Retry-After)',
  })
  @ApiServiceUnavailableResponse({
    description: 'X0003 storage indisponível ou réplica ocupada (Retry-After)',
  })
  async upload(
    @Req() req: IncomingMessage,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') rawIdempotencyKey?: string,
  ): Promise<UploadAccepted> {
    const idempotencyKey = await parseIdempotencyKey(rawIdempotencyKey, req);

    const declaredLength = Number(req.headers['content-length']);
    if (declaredLength > this.settings.maxUploadBytes + MULTIPART_OVERHEAD_BYTES) {
      await drainRequest(req);
      throw VideoErrors.FILE_TOO_LARGE(this.settings.maxUploadMb);
    }

    if (idempotencyKey) {
      const replay = await this.uploadVideo.findReplay(user.id, idempotencyKey);
      if (replay) {
        await drainRequest(req);
        return replay;
      }
    }

    try {
      await this.uploadVideo.assertWithinPendingLimit(user.id, this.slots.inFlightFor(user.id));
    } catch (error) {
      await drainRequest(req);
      throw error;
    }
    const release = this.slots.tryAcquire(user.id);
    if (!release) {
      // The replica is streaming as many uploads as its memory allows: try again shortly.
      await drainRequest(req);
      throw CommonErrors.UNAVAILABLE(UPLOAD_BUSY_RETRY_AFTER_SECONDS);
    }

    const correlationId = getCorrelationId() ?? randomUUID();
    try {
      return await readMultipartFile(
        req,
        { maxBytes: this.settings.maxUploadBytes, maxMb: this.settings.maxUploadMb },
        ({ file, signal }) =>
          this.uploadVideo.execute({
            userId: user.id,
            correlationId,
            idempotencyKey,
            file,
            signal,
          }),
      );
    } finally {
      release();
    }
  }

  @Get()
  @ApiOperation({ summary: 'Vídeos do usuário (mais recentes primeiro)' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'status', required: false, enum: VIDEO_STATUSES })
  @ApiOkResponse({ type: VideoListDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(listVideosQuerySchema)) query: ListVideosQuery,
  ): Promise<VideoListView> {
    return this.listVideos.execute({ userId: user.id, ...query });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhe com o histórico de status' })
  @ApiOkResponse({ type: VideoDetailDto })
  @ApiNotFoundResponse({
    description: 'V0001 VIDEO_NOT_FOUND (também para vídeo de outro usuário)',
  })
  detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<VideoDetailView> {
    return this.getVideo.execute(user.id, id);
  }

  @Post(':id/download-url')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'URL assinada (HMAC, 5 min) para baixar o zip dos frames' })
  @ApiOkResponse({ type: DownloadUrlDto })
  @ApiNotFoundResponse({ description: 'V0001 VIDEO_NOT_FOUND' })
  @ApiConflictResponse({ description: 'V0004 VIDEO_NOT_READY' })
  @ApiGoneResponse({ description: 'V0006 ZIP_EXPIRED (retenção)' })
  downloadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<DownloadUrl> {
    return this.createDownloadUrl.execute(user.id, id);
  }
}

async function parseIdempotencyKey(
  raw: string | undefined,
  req: IncomingMessage,
): Promise<string | undefined> {
  if (raw === undefined || raw === '') return undefined;
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  await drainRequest(req);
  throw CommonErrors.VALIDATION([
    { field: 'Idempotency-Key', message: parsed.error.issues[0]?.message ?? 'inválido' },
  ]);
}
