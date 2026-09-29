import { ServiceUnavailableException } from '@nestjs/common';

/** Result of one readiness evaluation. */
export type ReadinessCheck = () => Promise<unknown>;

/** How long a readiness result is reused: probes and public callers share one evaluation. */
export const READINESS_CACHE_MS = 2_000;

/**
 * `GET /api/health/ready` is public: every call would otherwise run a database query and two
 * bucket checks. The result is reused for {@link READINESS_CACHE_MS} and concurrent calls share
 * the same evaluation. `check` resolves when every dependency is up and rejects with Terminus's
 * `ServiceUnavailableException` when one is down (Terminus already logs the details, which stay
 * out of the public response: they carry internal hosts, IPs and the database user).
 */
export class CachedReadiness {
  private last?: { at: number; ready: boolean };
  private inFlight?: Promise<boolean>;

  constructor(
    private readonly check: ReadinessCheck,
    private readonly ttlMs = READINESS_CACHE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  isReady(): Promise<boolean> {
    if (this.last && this.now() - this.last.at < this.ttlMs) {
      return Promise.resolve(this.last.ready);
    }
    this.inFlight ??= this.evaluate().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async evaluate(): Promise<boolean> {
    let ready: boolean;
    try {
      await this.check();
      ready = true;
    } catch (error) {
      if (!(error instanceof ServiceUnavailableException)) throw error;
      ready = false;
    }
    this.last = { at: this.now(), ready };
    return ready;
  }
}

export const CACHED_READINESS = Symbol('CACHED_READINESS');
