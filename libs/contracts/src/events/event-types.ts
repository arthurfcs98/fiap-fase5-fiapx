/**
 * Todos os `type` de evento v1 (docs/arquitetura/contratos.md, seção 2 — "Eventos", e seção 12
 * — "Propagação da eliminação"). O `type` de cada evento é igual à routing key no
 * `fiapx.events`; `ROUTING_KEYS` de `@fiapx/messaging` é este mesmo objeto.
 */
export const EVENT_TYPES = {
  videoUploaded: 'video.uploaded',
  processingStarted: 'video.processing.started',
  processingCompleted: 'video.processing.completed',
  processingFailed: 'video.processing.failed',
  videoFailed: 'video.failed',
  videoCompleted: 'video.completed',
  userDeleted: 'user.deleted',
} as const;

/** União de todos os `type` de evento (= routing keys no `fiapx.events`). */
export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
