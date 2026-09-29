/** Falha ao publicar: broker recusou (nack/`reject-publish`), timeout do confirm ou canal fechado. */
export class PublishError extends Error {
  constructor(
    public readonly exchange: string,
    public readonly routingKey: string,
    options?: { cause?: unknown },
  ) {
    super(`Falha ao publicar em "${exchange}" com routing key "${routingKey}"`, options);
    this.name = 'PublishError';
  }
}

/**
 * Mensagem `mandatory` sem fila de destino (o broker devolveu com `basic.return`). Indica
 * topologia ausente ou routing key errada: sem este erro, a mensagem seria descartada em silêncio.
 */
export class UnroutableMessageError extends PublishError {
  constructor(exchange: string, routingKey: string) {
    super(exchange, routingKey);
    this.name = 'UnroutableMessageError';
    this.message = `Mensagem sem rota em "${exchange || '(default)'}" com routing key "${routingKey}"`;
  }
}

/** Envelope que não passa no schema do contrato: bug do produtor, nunca é publicado. */
export class InvalidEventError extends Error {
  constructor(
    public readonly eventType: string,
    public readonly reason: string,
  ) {
    super(`Evento inválido (${eventType}): ${reason}`);
    this.name = 'InvalidEventError';
  }
}
