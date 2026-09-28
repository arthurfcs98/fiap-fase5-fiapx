import { Module } from '@nestjs/common';
import type { HealthIndicatorFunction } from '@nestjs/terminus';
import { TerminusModule } from '@nestjs/terminus';
import { READINESS_CHECKS } from './health.constants';
import { HealthController } from './interfaces/controllers/health.controller';

@Module({
  imports: [TerminusModule.forRoot({ errorLogStyle: 'json' })],
  controllers: [HealthController],
  providers: [{ provide: READINESS_CHECKS, useValue: [] satisfies HealthIndicatorFunction[] }],
})
export class HealthModule {}
