import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { HealthCheckResult, HealthIndicatorFunction } from '@nestjs/terminus';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import type { ApiConfig } from '../../../../config/api.config';
import { API_CONFIG, SERVICE_NAME } from '../../../../config/api.config';
import { READINESS_CHECKS } from '../../health.constants';
import { LivenessResponseDto } from '../dto/liveness.response.dto';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(READINESS_CHECKS) private readonly readinessChecks: HealthIndicatorFunction[],
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
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness: dependências necessárias para atender',
    description: 'Postgres e storage entram na E3. Responde 503 se alguma checagem falhar.',
  })
  ready(): Promise<HealthCheckResult> {
    return this.health.check(this.readinessChecks);
  }
}
