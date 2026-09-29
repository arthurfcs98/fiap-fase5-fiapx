import { Controller, Get, Header, Param, Query, StreamableFile } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../../auth/interfaces/decorators/public.decorator';
import { OpenDownloadUseCase } from '../../application/use-cases/open-download.use-case';
import { attachmentDisposition } from '../http/content-disposition';

@ApiTags('videos')
@Controller('downloads')
export class DownloadsController {
  constructor(private readonly openDownload: OpenDownloadUseCase) {}

  @Get(':id')
  @Public()
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({
    summary: 'Download do zip (link assinado, sem Bearer)',
    description: 'Gerado por POST /api/videos/:id/download-url; vale 5 minutos.',
  })
  @ApiQuery({ name: 'exp', description: 'Expiração (epoch em segundos)' })
  @ApiQuery({ name: 'sig', description: 'Assinatura HMAC-SHA256 (base64url)' })
  @ApiProduces('application/zip')
  @ApiOkResponse({ description: 'Stream application/zip' })
  @ApiForbiddenResponse({ description: 'V0005 INVALID_DOWNLOAD_SIGNATURE' })
  @ApiConflictResponse({ description: 'V0004 VIDEO_NOT_READY' })
  @ApiGoneResponse({ description: 'V0006 ZIP_EXPIRED (retenção)' })
  async download(
    @Param('id') id: string,
    @Query('exp') expires: unknown,
    @Query('sig') signature: unknown,
  ): Promise<StreamableFile> {
    const zip = await this.openDownload.execute({ videoId: id, expires, signature });
    return new StreamableFile(zip.body, {
      type: 'application/zip',
      length: zip.sizeBytes,
      disposition: attachmentDisposition(zip.fileName),
    });
  }
}
