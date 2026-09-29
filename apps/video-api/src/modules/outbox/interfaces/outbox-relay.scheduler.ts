import type { OnModuleDestroy } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { Clock } from '../../../shared/domain/clock';
import { CLOCK } from '../../../shared/domain/clock';
import { OUTBOX_BATCH_SIZE, OutboxRelay } from '../application/outbox-relay';

/** contratos.md, section 5: every 500 ms. */
export const OUTBOX_POLL_MS = 500;
const LOG_EVERY_MS = 60_000;

/**
 * Runs the relay every 500 ms (`@nestjs/schedule`), never two ticks at once in the same
 * process. A database outage is logged once a minute, not every tick. On shutdown it waits for
 * the batch in flight before messaging closes the publisher.
 */
@Injectable()
export class OutboxRelayScheduler implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayScheduler.name);
  private running: Promise<void> | undefined;
  private stopped = false;
  private lastErrorLoggedAt = Number.NEGATIVE_INFINITY;
  private failing = false;

  constructor(
    private readonly relay: OutboxRelay,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Interval('outbox-relay', OUTBOX_POLL_MS)
  tick(): Promise<void> {
    if (this.stopped || this.running) return this.running ?? Promise.resolve();
    this.running = this.runOnce().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  private async runOnce(): Promise<void> {
    try {
      // Keep draining while full batches are published (bursts go out without waiting 500 ms).
      for (;;) {
        const result = await this.relay.relayBatch();
        this.recovered();
        if (this.stopped || result.failed > 0 || result.claimed < OUTBOX_BATCH_SIZE) return;
      }
    } catch (error) {
      this.failed(error);
    }
  }

  private recovered(): void {
    if (!this.failing) return;
    this.failing = false;
    this.logger.log('Outbox relay voltou a funcionar');
  }

  private failed(error: unknown): void {
    this.failing = true;
    const now = this.clock.now().getTime();
    if (now - this.lastErrorLoggedAt < LOG_EVERY_MS) return;
    this.lastErrorLoggedAt = now;
    this.logger.error({
      msg: 'Outbox relay falhou (banco indisponível?)',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
