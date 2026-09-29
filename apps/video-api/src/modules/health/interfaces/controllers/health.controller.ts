import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../../auth/interfaces/decorators/public.decorator';
import type { ApiConfig } from '../../../../config/api.config';
import { API_CONFIG, SERVICE_NAME } from '../../../../config/api.config';
import type { CachedReadiness } from '../../infrastructure/cached-readiness';
import { CACHED_READINESS } from '../../infrastructure/cached-readiness';
import { LivenessResponseDto, ReadinessResponseDto } from '../dto/liveness.response.dto';

/** The slice of the Express response the readiness route touches. */
interface StatusResponse {
  status(code: number): unknown;
}

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CACHED_READINESS) private readonly readiness: CachedReadiness,
  ) {}

  @Get('live')
  @ApiOperation({
    summary: 'Liveness: o processo está de pé',
    description:
      'Não consulta dependências. `version` é a revisão de build (usada no smoke do deploy).',
  })
  @ApiOkResponse({ type: LivenessResponseDto })
  live(): LivenessResponseDto {
    return { status: 'ok', service: SERVICE_NAME, version: this.config.APP_VERSION };
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness: dependências necessárias para atender',
    description:
      'Postgres (SELECT 1) e storage (os dois buckets), com o resultado reaproveitado por 2 s. ' +
      'RabbitMQ fica de fora: com o outbox a API aceita uploads com o broker fora. Responde 503 ' +
      'se alguma checagem falhar; o motivo fica só no log (a rota é pública).',
  })
  @ApiOkResponse({ type: ReadinessResponseDto })
  @ApiServiceUnavailableResponse({ type: ReadinessResponseDto })
  async ready(@Res({ passthrough: true }) response: StatusResponse): Promise<ReadinessResponseDto> {
    const ready = await this.readiness.isReady();
    if (!ready) response.status(HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ready ? 'ok' : 'unavailable',
      service: SERVICE_NAME,
      version: this.config.APP_VERSION,
    };
  }
}
