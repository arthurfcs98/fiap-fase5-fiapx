/**
 * Verificações internas de "o processo ainda faz o seu trabalho" (ex.: os consumidores de fila
 * estão assinados). Não são dependências externas (Postgres/storage ficam no readiness do api):
 * reiniciar o pod precisa resolver o problema. O `/health` da porta de métricas (`:9464`, a
 * sonda de liveness do worker e do notification-service) responde 503 enquanto alguma falhar.
 */
export type HealthCheck = () => boolean;

export class HealthRegistry {
  private readonly checks = new Map<string, HealthCheck>();

  /** Registra (ou substitui) uma verificação pelo nome. */
  register(name: string, check: HealthCheck): void {
    this.checks.set(name, check);
  }

  unregister(name: string): void {
    this.checks.delete(name);
  }

  /** Nomes das verificações que falham agora (lançar exceção conta como falha). */
  failing(): string[] {
    const failing: string[] = [];
    for (const [name, check] of this.checks) {
      let healthy: boolean;
      try {
        healthy = check();
      } catch {
        healthy = false;
      }
      if (!healthy) failing.push(name);
    }
    return failing;
  }
}

/** Token do {@link HealthRegistry} do serviço (provido, global, pelo `MetricsServerModule`). */
export const HEALTH_REGISTRY = Symbol('HEALTH_REGISTRY');
