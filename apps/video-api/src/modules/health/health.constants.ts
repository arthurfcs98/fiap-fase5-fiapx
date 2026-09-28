/**
 * Lista de checagens de readiness (`HealthIndicatorFunction[]`) usada por GET /api/health/ready.
 * Vazia na E0. Na E3 entram, via `useFactory` no HealthModule:
 *   () => db.pingCheck('database')      (TypeOrmHealthIndicator)
 *   () => storage.isHealthy('storage')  (indicador próprio com HEAD no bucket)
 * RabbitMQ fica de fora de propósito: com outbox, a API aceita uploads com o broker fora.
 */
export const READINESS_CHECKS = Symbol('READINESS_CHECKS');
