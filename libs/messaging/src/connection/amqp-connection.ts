import type {
  AmqpConnectionManager,
  AmqpConnectionManagerOptions,
  ChannelWrapper,
} from 'amqp-connection-manager';
import { connect as connectManager } from 'amqp-connection-manager';
import type { Channel, ChannelModel } from 'amqplib';
import type { MessagingLogger } from '../messaging.logger';
import { defaultLogger, describeError } from '../messaging.logger';

export interface AmqpConnectionOptions {
  /** `RABBITMQ_URL` (nunca é logada: contém a senha). */
  url: string;
  /** Nome da conexão na UI do RabbitMQ (use o nome do serviço). */
  connectionName: string;
  /** Padrão: 15 s. */
  heartbeatIntervalInSeconds?: number;
  /** Intervalo entre tentativas de reconexão. Padrão: 5 s. */
  reconnectTimeInSeconds?: number;
  /**
   * Espera antes de decidir que um canal fechou por erro do broker (e não por queda da conexão
   * ou por `close()` intencional). Padrão: 500 ms.
   */
  channelRecoveryDelayMs?: number;
  logger?: MessagingLogger;
}

export type AmqpConnectFn = (
  urls: string[],
  options: AmqpConnectionManagerOptions,
) => AmqpConnectionManager;

export interface ManagedChannelOptions {
  /** Nome do canal (logs). */
  name: string;
  /** `true` = ConfirmChannel (publicação com publisher confirms). */
  confirm: boolean;
  /** Timeout padrão de confirm das publicações deste canal. */
  publishTimeoutMs?: number;
  /** Roda a cada (re)conexão, antes de liberar publicações/consumo. */
  setup?: (channel: Channel) => Promise<void>;
}

const DEFAULT_HEARTBEAT_S = 15;
const DEFAULT_RECONNECT_S = 5;
const DEFAULT_CHANNEL_RECOVERY_DELAY_MS = 500;

/**
 * Conexão AMQP com reconexão automática (`amqp-connection-manager`).
 *
 * - Não bloqueia o boot: conecta em segundo plano e reconecta a cada `reconnectTimeInSeconds`.
 *   Publicações feitas sem conexão ficam em buffer até o timeout de confirm.
 * - Canais criados por {@link createChannel} refazem o `setup` a cada reconexão.
 * - O `amqp-connection-manager` NÃO recria um canal fechado pelo broker enquanto a conexão
 *   continua de pé (ex.: ack de delivery tag desconhecida, 404 de exchange). Nesse caso esta
 *   classe força uma reconexão (no máximo uma a cada `reconnectTimeInSeconds`), senão o canal
 *   ficaria morto até a próxima queda de rede.
 */
export class AmqpConnection {
  readonly manager: AmqpConnectionManager;
  private readonly logger: MessagingLogger;
  private readonly reconnectIntervalMs: number;
  private readonly channelRecoveryDelayMs: number;
  private closing = false;
  private lastForcedReconnectAt = 0;

  constructor(
    private readonly options: AmqpConnectionOptions,
    connectFn: AmqpConnectFn = connectManager,
  ) {
    this.logger = options.logger ?? defaultLogger('AmqpConnection');
    const reconnectS = options.reconnectTimeInSeconds ?? DEFAULT_RECONNECT_S;
    this.reconnectIntervalMs = reconnectS * 1000;
    this.channelRecoveryDelayMs =
      options.channelRecoveryDelayMs ?? DEFAULT_CHANNEL_RECOVERY_DELAY_MS;

    this.manager = connectFn([options.url], {
      heartbeatIntervalInSeconds: options.heartbeatIntervalInSeconds ?? DEFAULT_HEARTBEAT_S,
      reconnectTimeInSeconds: reconnectS,
      connectionOptions: { clientProperties: { connection_name: options.connectionName } },
    });
    this.registerListeners();
  }

  get connectionName(): string {
    return this.options.connectionName;
  }

  isConnected(): boolean {
    return this.manager.isConnected();
  }

  /** Conexão amqplib atual (`undefined` enquanto desconectado). */
  get currentConnection(): ChannelModel | undefined {
    return this.manager.connection;
  }

  /**
   * Chamado a cada (re)conexão com a conexão amqplib crua (ex.: declarar a topologia num canal
   * efêmero). Se já estiver conectado, roda também agora. Devolve a função que remove o listener.
   */
  onConnect(listener: (connection: ChannelModel) => void): () => void {
    const handler = ({ connection }: { connection: unknown }) =>
      listener(connection as ChannelModel);
    this.manager.on('connect', handler);
    const current = this.currentConnection;
    if (current) listener(current);
    return () => {
      this.manager.removeListener('connect', handler);
    };
  }

  /** Espera a conexão ficar de pé (rejeita no timeout; as tentativas continuam em segundo plano). */
  async waitForConnect(timeoutMs = 30_000): Promise<void> {
    if (this.manager.isConnected()) return;
    await this.manager.connect({ timeout: timeoutMs });
  }

  createChannel(options: ManagedChannelOptions): ChannelWrapper {
    let current: Channel | undefined;
    let intentionallyClosed = false;

    const wrapper = this.manager.createChannel({
      name: options.name,
      confirm: options.confirm,
      publishTimeout: options.publishTimeoutMs,
      setup: async (channel: Channel) => {
        current = channel;
        channel.on('error', (error: unknown) => {
          this.logger.warn({
            msg: `Canal AMQP "${options.name}" com erro`,
            channel: options.name,
            error: describeError(error),
          });
        });
        channel.once('close', () => {
          this.scheduleChannelRecovery(options.name, () => {
            return !intentionallyClosed && current === channel;
          });
        });
        await options.setup?.(channel);
      },
    });

    wrapper.once('close', () => {
      intentionallyClosed = true;
    });
    wrapper.on('error', (error: unknown) => {
      this.logger.error({
        msg: `Falha no setup do canal AMQP "${options.name}"`,
        channel: options.name,
        error: describeError(error),
      });
    });
    return wrapper;
  }

  /**
   * Fecha canais e conexão. Com o broker fora, o `amqp-connection-manager` só conclui o close
   * depois da tentativa de conexão em andamento (até `reconnectTimeInSeconds`): o shutdown não
   * espera mais que isso.
   */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.reconnectIntervalMs + 1_000);
      timer.unref();
    });
    const outcome = await Promise.race([
      this.manager.close().then(() => 'closed' as const),
      timeout,
    ]);
    clearTimeout(timer);
    this.logger.log(
      outcome === 'closed'
        ? `Conexão AMQP "${this.options.connectionName}" encerrada`
        : `Conexão AMQP "${this.options.connectionName}" abandonada no shutdown (broker indisponível)`,
    );
  }

  private registerListeners(): void {
    this.manager.on('connect', () => {
      this.logger.log(`Conectado ao RabbitMQ como "${this.options.connectionName}"`);
    });
    this.manager.on('disconnect', ({ err }: { err?: unknown }) => {
      if (this.closing) return;
      this.logger.warn({
        msg: 'Conexão com o RabbitMQ perdida; reconectando',
        error: describeError(err),
      });
    });
    this.manager.on('connectFailed', ({ err }: { err?: unknown }) => {
      this.logger.warn({
        msg: 'Falha ao conectar no RabbitMQ; nova tentativa em breve',
        error: describeError(err),
      });
    });
    this.manager.on('blocked', ({ reason }: { reason?: string }) => {
      this.logger.warn({ msg: 'RabbitMQ bloqueou as publicações (alarme)', reason });
    });
    this.manager.on('unblocked', () => {
      this.logger.log('RabbitMQ liberou as publicações');
    });
  }

  private scheduleChannelRecovery(name: string, stillBroken: () => boolean): void {
    if (this.closing) return;
    const timer = setTimeout(() => {
      if (this.closing || !stillBroken() || !this.manager.isConnected()) return;
      const elapsed = Date.now() - this.lastForcedReconnectAt;
      if (elapsed < this.reconnectIntervalMs) {
        this.scheduleChannelRecovery(name, stillBroken);
        return;
      }
      this.lastForcedReconnectAt = Date.now();
      this.logger.warn({
        msg: `Canal AMQP "${name}" fechado pelo broker com a conexão ativa; forçando reconexão`,
        channel: name,
      });
      this.manager.reconnect();
    }, this.channelRecoveryDelayMs);
    timer.unref();
  }
}
