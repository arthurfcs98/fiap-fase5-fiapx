import type { ChannelModel } from 'amqplib';
import { connect as amqplibConnect } from 'amqplib';
import type { AmqpConnection } from './connection/amqp-connection';
import type { MessagingLogger } from './messaging.logger';
import { defaultLogger, describeError } from './messaging.logger';
import type { Topology } from './topology';
import { buildTopology } from './topology';

/** Subconjunto do canal amqplib usado para declarar a topologia (facilita dublês em teste). */
export interface TopologyChannel {
  assertExchange(exchange: string, type: string, options: { durable: boolean }): Promise<unknown>;
  assertQueue(
    queue: string,
    options: { durable: boolean; arguments: Record<string, unknown> },
  ): Promise<unknown>;
  bindQueue(queue: string, exchange: string, pattern: string): Promise<unknown>;
}

/**
 * Declara exchanges, filas e bindings de forma idempotente (contratos.md, seção 2).
 * Uma fila que já existe com OUTROS argumentos faz o broker fechar o canal com
 * PRECONDITION_FAILED, de propósito: mudar argumento de fila exige migração.
 */
export async function assertTopology(
  channel: TopologyChannel,
  topology: Topology = buildTopology(),
): Promise<void> {
  for (const exchange of topology.exchanges) {
    await channel.assertExchange(exchange.name, exchange.type, { durable: exchange.durable });
  }
  for (const queue of topology.queues) {
    await channel.assertQueue(queue.name, { durable: queue.durable, arguments: queue.arguments });
  }
  for (const binding of topology.bindings) {
    await channel.bindQueue(binding.queue, binding.exchange, binding.routingKey);
  }
}

export interface SetupTopologyOptions {
  /** `RABBITMQ_URL` de um usuário com permissão `configure`. */
  url: string;
  connectionName?: string;
  topology?: Topology;
  /** Injetável em testes. Padrão: `amqplib.connect`. */
  connect?: (
    url: string,
    socketOptions: { clientProperties: Record<string, string> },
  ) => Promise<ChannelModel>;
}

/**
 * One-shot `rabbitmq-init` (Job no K8s / serviço one-shot no compose): conecta, declara a
 * topologia inteira e fecha. Falha (rejeita) se o broker estiver fora ou se houver divergência
 * de argumentos, para o orquestrador não subir os serviços com a topologia errada.
 */
export async function setupTopology(options: SetupTopologyOptions): Promise<Topology> {
  const connect = options.connect ?? amqplibConnect;
  const topology = options.topology ?? buildTopology();
  const connection = await connect(options.url, {
    clientProperties: { connection_name: options.connectionName ?? 'rabbitmq-init' },
  });
  // Erros de canal/conexão (ex.: PRECONDITION_FAILED) também rejeitam a operação pendente:
  // os listeners só evitam o "Unhandled error" do EventEmitter.
  connection.on('error', ignore);
  try {
    const channel = await connection.createChannel();
    channel.on('error', ignore);
    await assertTopology(channel, topology);
    await channel.close();
  } finally {
    await connection.close();
  }
  return topology;
}

/**
 * Declara a topologia a cada (re)conexão, num canal efêmero, e expõe {@link whenReady}: canais
 * de consumo e de publicação esperam por ele no `setup`, então nenhum consumer começa numa fila
 * que ainda não existe (primeiro boot com broker vazio).
 *
 * Sem topologia (`topology` indefinida) a espera é liberada na hora: o serviço confia no
 * one-shot `rabbitmq-init`.
 */
export class TopologyInitializer {
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private declared = false;
  private unsubscribe?: () => void;
  private retryTimer?: NodeJS.Timeout;
  private readonly logger: MessagingLogger;

  constructor(
    private readonly connection: AmqpConnection,
    private readonly topology: Topology | undefined,
    logger?: MessagingLogger,
    /** Nova tentativa após falha, enquanto a mesma conexão estiver de pé. Padrão: 5 s. */
    private readonly retryDelayMs = 5_000,
  ) {
    this.logger = logger ?? defaultLogger('TopologyInitializer');
    this.ready = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
    if (!topology) this.markReady();
  }

  /** `true` depois da primeira declaração bem-sucedida (ou quando não há topologia a declarar). */
  get isReady(): boolean {
    return this.declared;
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  start(): void {
    const topology = this.topology;
    if (!topology || this.unsubscribe) return;
    this.unsubscribe = this.connection.onConnect((connection) => {
      void this.declare(connection, topology);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  /**
   * Declara a topologia AGORA na conexão atual (ex.: um consumer foi cancelado pelo broker porque
   * a fila foi apagada e recriada). Rejeita sem conexão ou se a declaração falhar; sem topologia
   * configurada, não faz nada.
   */
  async redeclare(): Promise<void> {
    const topology = this.topology;
    if (!topology) return;
    const connection = this.connection.currentConnection;
    if (!connection) throw new Error('RabbitMQ desconectado: topologia não declarada');
    const channel = await connection.createChannel();
    channel.on('error', ignore);
    try {
      await assertTopology(channel, topology);
    } finally {
      await channel.close().catch(ignore);
    }
  }

  private async declare(connection: ChannelModel, topology: Topology): Promise<void> {
    try {
      const channel = await connection.createChannel();
      // O erro (ex.: PRECONDITION_FAILED) também rejeita a operação pendente: logado abaixo.
      channel.on('error', ignore);
      await assertTopology(channel, topology);
      await channel.close();
      if (!this.declared) {
        this.logger.log(
          `Topologia RabbitMQ declarada: ${topology.exchanges.length} exchanges, ` +
            `${topology.queues.length} filas, ${topology.bindings.length} bindings`,
        );
      }
      this.markReady();
    } catch (error) {
      this.logger.error({
        msg: `Falha ao declarar a topologia RabbitMQ; nova tentativa em ${this.retryDelayMs} ms`,
        error: describeError(error),
      });
      this.scheduleRetry(connection, topology);
    }
  }

  private scheduleRetry(connection: ChannelModel, topology: Topology): void {
    if (!this.unsubscribe) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.unsubscribe || this.connection.currentConnection !== connection) return;
      void this.declare(connection, topology);
    }, this.retryDelayMs);
    this.retryTimer.unref();
  }

  private markReady(): void {
    this.declared = true;
    this.resolveReady();
  }
}

function ignore(): void {
  // Intencionalmente vazio (ver os comentários nos pontos de uso).
}
