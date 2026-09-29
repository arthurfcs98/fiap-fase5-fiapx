import { EVENT_TYPES } from '@fiapx/contracts';

/**
 * Topologia RabbitMQ do FIAP X — fonte única em código.
 * Espelha docs/arquitetura/contratos.md (seção 2): mudar aqui = mudança coordenada.
 *
 * Na E2, o one-shot `rabbitmq-init` e o startup de cada serviço declaram exatamente o que
 * `buildTopology()` devolve (idempotente). Mudar um argumento de fila existente gera
 * PRECONDITION_FAILED de propósito (exige migração de fila).
 */
export const EXCHANGES = {
  /** topic: todos os eventos de domínio e de processamento. */
  events: 'fiapx.events',
  /** direct: dead-letter; routing key = nome da fila de origem. */
  deadLetter: 'fiapx.dlx',
} as const;

/**
 * Routing keys = `type` dos eventos (contratos.md, seção 2). Vêm de `@fiapx/contracts` para não
 * existirem duas listas que podem divergir.
 */
export const ROUTING_KEYS = EVENT_TYPES;

export const QUEUES = {
  workerVideoUploaded: 'worker.video-uploaded',
  apiVideoProcessing: 'api.video-processing',
  apiVideoDeadLetter: 'api.video-deadletter',
  notificationEvents: 'notification.events',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Quantas vezes uma mensagem pode voltar à fila (crash sem ack) antes de ir para o DLX. */
export const DELIVERY_LIMIT = 5;

/** TTL fixo de cada fila `.retry.N` (sem head-of-line blocking): 5 s, 30 s, 2 min. */
export const RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const;
/** Número máximo de retries por falha transitória (4 tentativas no total). */
export const MAX_RETRIES = RETRY_DELAYS_MS.length;

export interface ExchangeDefinition {
  name: string;
  type: 'topic' | 'direct';
  durable: true;
}

export interface QueueDefinition {
  name: string;
  /** Filas quorum só existem duráveis: o `assertQueue` da E2 precisa passar `durable: true`. */
  durable: true;
  arguments: Record<string, string | number>;
}

export interface BindingDefinition {
  queue: string;
  exchange: string;
  routingKey: string;
}

export interface Topology {
  exchanges: ExchangeDefinition[];
  queues: QueueDefinition[];
  bindings: BindingDefinition[];
}

export interface TopologyOptions {
  /**
   * TTL de cada nível `.retry.N` (padrão {@link RETRY_DELAYS_MS}). Só para testes de integração
   * (broker descartável): o TTL é argumento de fila, então valores diferentes num broker que já
   * tem as filas geram PRECONDITION_FAILED. Produção usa sempre o padrão do contrato.
   */
  retryDelaysMs?: readonly number[];
}

/**
 * Bindings das filas principais (as filas de retry não têm binding; as DLQs são derivadas).
 * Binding novo num broker que já tem a fila é aditivo: o `bindQueue` do startup o cria sem
 * PRECONDITION_FAILED (só argumento de fila exige migração).
 */
export const MAIN_QUEUE_BINDINGS: Readonly<Record<QueueName, readonly BindingDefinition[]>> = {
  [QUEUES.workerVideoUploaded]: [
    bind(QUEUES.workerVideoUploaded, EXCHANGES.events, ROUTING_KEYS.videoUploaded),
  ],
  [QUEUES.apiVideoProcessing]: [
    bind(QUEUES.apiVideoProcessing, EXCHANGES.events, 'video.processing.*'),
  ],
  [QUEUES.apiVideoDeadLetter]: [
    bind(QUEUES.apiVideoDeadLetter, EXCHANGES.deadLetter, QUEUES.workerVideoUploaded),
  ],
  [QUEUES.notificationEvents]: [
    bind(QUEUES.notificationEvents, EXCHANGES.events, ROUTING_KEYS.videoFailed),
    bind(QUEUES.notificationEvents, EXCHANGES.events, ROUTING_KEYS.videoCompleted),
    // LGPD (contratos.md, seção 12): anonimiza as notificações do usuário eliminado.
    bind(QUEUES.notificationEvents, EXCHANGES.events, ROUTING_KEYS.userDeleted),
  ],
};

export function retryQueueName(queue: string, level: number): string {
  assertRetryLevel(level);
  return `${queue}.retry.${level}`;
}

export function deadLetterQueueName(queue: string): string {
  return `${queue}.dlq`;
}

/**
 * Argumentos das filas principais: quorum, delivery-limit e DLX at-least-once
 * (`reject-publish` é pré-requisito do at-least-once; sem `x-max-length`, nada é descartado).
 */
export function mainQueueArguments(queue: string): Record<string, string | number> {
  return {
    'x-queue-type': 'quorum',
    'x-delivery-limit': DELIVERY_LIMIT,
    'x-dead-letter-exchange': EXCHANGES.deadLetter,
    'x-dead-letter-routing-key': queue,
    'x-dead-letter-strategy': 'at-least-once',
    'x-overflow': 'reject-publish',
  };
}

/** Filas `.retry.N`: TTL fixo; ao expirar, voltam à fila original pela default exchange. */
export function retryQueueArguments(
  queue: string,
  level: number,
  retryDelaysMs: readonly number[] = RETRY_DELAYS_MS,
): Record<string, string | number> {
  assertRetryLevel(level);
  assertRetryDelays(retryDelaysMs);
  return {
    'x-queue-type': 'quorum',
    'x-message-ttl': retryDelaysMs[level - 1],
    'x-dead-letter-exchange': '',
    'x-dead-letter-routing-key': queue,
    'x-dead-letter-strategy': 'at-least-once',
    'x-overflow': 'reject-publish',
  };
}

/** Topologia completa: exchanges, filas principais + `.retry.1..3` + `.dlq`, e bindings. */
export function buildTopology(options: TopologyOptions = {}): Topology {
  const retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const queues: QueueDefinition[] = [];
  const bindings: BindingDefinition[] = [];

  for (const queue of Object.values(QUEUES)) {
    queues.push({ name: queue, durable: true, arguments: mainQueueArguments(queue) });
    for (let level = 1; level <= MAX_RETRIES; level += 1) {
      queues.push({
        name: retryQueueName(queue, level),
        durable: true,
        arguments: retryQueueArguments(queue, level, retryDelaysMs),
      });
    }
    const dlq = deadLetterQueueName(queue);
    queues.push({ name: dlq, durable: true, arguments: { 'x-queue-type': 'quorum' } });

    bindings.push(...MAIN_QUEUE_BINDINGS[queue]);
    bindings.push(bind(dlq, EXCHANGES.deadLetter, queue));
  }

  return {
    exchanges: [
      { name: EXCHANGES.events, type: 'topic', durable: true },
      { name: EXCHANGES.deadLetter, type: 'direct', durable: true },
    ],
    queues,
    bindings,
  };
}

function bind(queue: string, exchange: string, routingKey: string): BindingDefinition {
  return { queue, exchange, routingKey };
}

function assertRetryDelays(retryDelaysMs: readonly number[]): void {
  const valid =
    retryDelaysMs.length === MAX_RETRIES &&
    retryDelaysMs.every((delay) => Number.isInteger(delay) && delay > 0);
  if (!valid) {
    throw new RangeError(
      `retryDelaysMs inválido: [${retryDelaysMs.join(', ')}] (esperado ${MAX_RETRIES} inteiros > 0)`,
    );
  }
}

function assertRetryLevel(level: number): void {
  if (!Number.isInteger(level) || level < 1 || level > MAX_RETRIES) {
    throw new RangeError(`Nível de retry inválido: ${level} (esperado 1..${MAX_RETRIES})`);
  }
}
