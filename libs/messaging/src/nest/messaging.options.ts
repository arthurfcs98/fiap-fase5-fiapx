import { ConfigurableModuleBuilder } from '@nestjs/common';
import type { TopologyOptions } from '../topology';

export interface MessagingModuleOptions {
  /** `RABBITMQ_URL`. */
  url: string;
  /** Nome da conexão no RabbitMQ e AMQP `appId` (use o `SERVICE_NAME` do app). */
  connectionName: string;
  /**
   * Declara a topologia do contrato a cada (re)conexão, antes de consumir/publicar.
   * Padrão: `true` (contratos.md: "aplicada de forma idempotente no startup de cada serviço").
   */
  assertTopology?: boolean;
  /** Só para testes com broker descartável (ex.: TTLs curtos nas `.retry.N`). */
  topology?: TopologyOptions;
  /** Timeout do publisher confirm. Padrão: 5000 ms. */
  confirmTimeoutMs?: number;
  /** Padrão: 15 s. */
  heartbeatIntervalInSeconds?: number;
  /** Padrão: 5 s. */
  reconnectTimeInSeconds?: number;
  /**
   * Quanto esperar as mensagens em processamento no shutdown (SIGTERM) antes de fechar os
   * canais. Padrão: 30000 ms. O worker usa um valor maior (termina o vídeo atual).
   */
  shutdownTimeoutMs?: number;
}

/** Token de injeção das opções do {@link MessagingModule}. */
export const {
  ConfigurableModuleClass: MessagingConfigurableModule,
  MODULE_OPTIONS_TOKEN: MESSAGING_OPTIONS,
} = new ConfigurableModuleBuilder<MessagingModuleOptions>()
  .setClassMethodName('forRoot')
  .setExtras({ isGlobal: true }, (definition, extras) => ({
    ...definition,
    global: extras.isGlobal,
  }))
  .build();
