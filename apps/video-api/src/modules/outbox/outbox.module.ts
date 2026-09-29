import { METRICS_REGISTRY } from '@fiapx/observability';
import { Module } from '@nestjs/common';
import type { Registry } from '@prometheus-io/client';
import { OutboxRelay } from './application/outbox-relay';
import type { OutboxStore } from './domain/outbox.ports';
import { OUTBOX_STORE } from './domain/outbox.ports';
import { registerOutboxPendingGauge } from './infrastructure/prometheus-outbox.metrics';
import { OutboxRelayScheduler } from './interfaces/outbox-relay.scheduler';

export const OUTBOX_PENDING_GAUGE = Symbol('OUTBOX_PENDING_GAUGE');

/** Outbox relay (every 500 ms) and the `fiapx_outbox_pending` gauge. */
@Module({
  providers: [
    OutboxRelay,
    OutboxRelayScheduler,
    {
      provide: OUTBOX_PENDING_GAUGE,
      inject: [METRICS_REGISTRY, OUTBOX_STORE],
      useFactory: (registry: Registry, store: OutboxStore) =>
        registerOutboxPendingGauge(registry, store),
    },
  ],
})
export class OutboxModule {}
