export * from './connection/amqp-connection';
export * from './consumer/consumer-runner';
export * from './consumer/consumer.types';
export * from './headers';
export * from './messaging.config';
export * from './messaging.errors';
export * from './messaging.logger';
export * from './messaging.metrics';
export * from './nest';
export * from './publisher/event-publisher.port';
export * from './publisher/message-publisher';
export * from './retry-decision';
export * from './topology';
export * from './topology-cli';
export * from './topology-setup';
// Dublês para testes: `@fiapx/messaging/testing` (fora do barrel de produção).
