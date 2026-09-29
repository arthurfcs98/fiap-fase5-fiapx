import { Counter } from '@prometheus-io/client';
import type { Registry } from '@prometheus-io/client';

/** contratos.md, seção 11. */
export const MESSAGES_CONSUMED_TOTAL = 'fiapx_messages_consumed_total';

/**
 * Valores do label `result` de `fiapx_messages_consumed_total`:
 * - `success`: handler terminou, ack;
 * - `retry`: falha transitória, cópia publicada na `.retry.N` e ack;
 * - `dead_letter`: retries esgotados, `nack(requeue=false)` → DLX;
 * - `permanent_failure`: `NonRetryableError` tratado como resultado de negócio, ack;
 * - `invalid`: envelope inválido, `nack(requeue=false)` → DLX;
 * - `requeued`: a cópia de retry não foi confirmada pelo broker, `reject(requeue=true)`
 *   (conta no `x-delivery-limit`);
 * - `deferred`: dependência fora (Postgres, storage, SMTP): `nack(requeue=true)`, que não conta
 *   no `x-delivery-limit`, e o consumo pausa com backoff (sem gastar retry);
 * - `aborted`: o canal que entregou a mensagem fechou durante o processamento; nada é
 *   confirmado nem publicado e o broker reentrega.
 */
export const CONSUME_RESULTS = [
  'success',
  'retry',
  'dead_letter',
  'permanent_failure',
  'invalid',
  'requeued',
  'deferred',
  'aborted',
] as const;

export type ConsumeResult = (typeof CONSUME_RESULTS)[number];

type ConsumedLabels = 'queue' | 'result';

/** Métricas de mensageria registradas no registry do serviço (`METRICS_REGISTRY`). */
export class MessagingMetrics {
  readonly consumedTotal: Counter<ConsumedLabels>;

  constructor(registry: Registry) {
    const existing = registry.getSingleMetric(MESSAGES_CONSUMED_TOTAL);
    this.consumedTotal =
      existing instanceof Counter
        ? existing
        : new Counter<ConsumedLabels>({
            name: MESSAGES_CONSUMED_TOTAL,
            help: 'Mensagens consumidas do RabbitMQ, por fila e resultado',
            labelNames: ['queue', 'result'],
            registers: [registry],
          });
  }

  consumed(queue: string, result: ConsumeResult): void {
    this.consumedTotal.inc({ queue, result });
  }

  /** Valor atual do contador para `queue` e `result` (testes e diagnóstico). */
  async consumedCount(queue: string, result: ConsumeResult): Promise<number> {
    const { values } = await this.consumedTotal.get();
    const match = values.find((value) => {
      const labels = value.labels as Partial<Record<ConsumedLabels, string | number>>;
      return labels.queue === queue && labels.result === result;
    });
    return match?.value ?? 0;
  }
}
