/**
 * Readiness checks (`HealthIndicatorFunction[]`) run by `GET /api/health/ready`: Postgres and
 * the storage buckets. RabbitMQ is left out on purpose: with the outbox the API keeps accepting
 * uploads while the broker is down (contratos.md, section 8).
 */
export const READINESS_CHECKS = Symbol('READINESS_CHECKS');
