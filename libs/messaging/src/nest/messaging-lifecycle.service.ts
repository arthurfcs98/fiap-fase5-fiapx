import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { AmqpConnection } from '../connection/amqp-connection';
import { MessagePublisher } from '../publisher/message-publisher';
import { TopologyInitializer } from '../topology-setup';

/**
 * Liga a mensageria ao ciclo de vida do Nest:
 * - init: começa a declarar a topologia a cada (re)conexão (não bloqueia o boot: a API aceita
 *   uploads com o broker fora, graças ao outbox);
 * - shutdown: depois que os consumidores pararam (`MessageConsumers.onModuleDestroy`), fecha o
 *   publicador e a conexão.
 */
@Injectable()
export class MessagingLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    private readonly connection: AmqpConnection,
    private readonly publisher: MessagePublisher,
    private readonly topology: TopologyInitializer,
  ) {}

  onModuleInit(): void {
    this.topology.start();
  }

  async onApplicationShutdown(): Promise<void> {
    this.topology.stop();
    await this.publisher.close().catch(() => undefined);
    await this.connection.close();
  }
}
