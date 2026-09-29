# Libs compartilhadas: API pública e exemplos

> Guia de uso das libs `@fiapx/*` para quem implementa os apps (E3 a E5). Os **nomes** (filas,
> eventos, headers, variáveis, métricas) vêm de [`contratos.md`](contratos.md); este arquivo
> mostra **como usar** o código. Tudo aqui tem teste unitário e, onde há dependência externa,
> teste de integração com o serviço real (`npm run test:int`).

## Visão geral

| Lib | Para quê | Subpath só de teste |
|---|---|---|
| `@fiapx/contracts` | Envelope, schemas zod e tipos dos 6 eventos, `createEvent`, `EVENT_SCHEMAS` | `@fiapx/contracts/fixtures` |
| `@fiapx/messaging` | Conexão com reconexão, topologia, publicador com confirm, `ConsumerRunner`, `MessagingModule` | `@fiapx/messaging/testing` |
| `@fiapx/storage` | Porta `IObjectStorage`, adaptador S3/Garage, `StorageModule`, chaves | `@fiapx/storage/testing` |
| `@fiapx/common` | Erros (A/V/P/X), `RetryableError`/`NonRetryableError`, config zod, TypeORM, `ZodValidationPipe` | — |
| `@fiapx/observability` | pino, correlation id, métricas e `/health` internos | — |
| `@fiapx/testing` | Testcontainers (RabbitMQ, Postgres, Redis, Garage) e `waitFor` para `*.int-spec.ts` | (é só de teste) |

Código de teste nunca é importado pelo código de produção: fixtures, fakes e containers ficam
nos subpaths acima, fora dos barrels.

## Configuração (um schema zod por app)

Cada app compõe o próprio schema com os blocos das libs; o `loadConfig` valida no boot (fail
fast) e aceita segredo por arquivo (`<VAR>_FILE`).

```ts
// apps/video-worker/src/config/worker.config.ts
import { baseServiceConfigShape } from '@fiapx/common';
import { messagingConfigShape } from '@fiapx/messaging';
import { metricsServerConfigShape } from '@fiapx/observability';
import { storageConfigShape } from '@fiapx/storage';

export const workerConfigSchema = z.object({
  ...baseServiceConfigShape,        // NODE_ENV, LOG_LEVEL, APP_VERSION
  ...metricsServerConfigShape,      // METRICS_PORT, METRICS_HOST, METRICS_TOKEN
  ...messagingConfigShape,          // RABBITMQ_URL (amqp:// ou amqps://)
  ...storageConfigShape,            // S3_* (endpoint, região, chave, buckets, path-style)
  WORKER_PREFETCH: z.coerce.number().int().min(1).default(1),
});
```

Para o Postgres (api e notification): `databaseConfigShape` de `@fiapx/common`
(`DB_HOST`, `DB_PORT` padrão 5432, `DB_USER`, `DB_PASSWORD`, `DB_NAME` e **`DB_SSL` obrigatória,
sem padrão**). O `compose.yaml` já passa todas essas variáveis para os três apps.

## Mensageria (`@fiapx/messaging`)

### Registrar o módulo (uma vez, no módulo raiz)

```ts
MessagingModule.forRootAsync({
  inject: [WORKER_CONFIG],
  useFactory: (config: WorkerConfig) => ({
    url: config.RABBITMQ_URL,
    connectionName: SERVICE_NAME,   // nome na UI do RabbitMQ e AMQP appId
    shutdownTimeoutMs: 300_000,     // worker: termina o vídeo atual no SIGTERM (padrão 30 s)
  }),
}),
```

- É **global**: qualquer módulo injeta `MessageConsumers`, `EVENT_PUBLISHER` (porta
  `EventPublisher`), `MessagePublisher`, `AmqpConnection`, `TopologyInitializer` e
  `MessagingMetrics` sem reimportar.
- **Não bloqueia o boot**: com o RabbitMQ fora, o app sobe e conecta quando o broker voltar
  (a API aceita uploads graças ao outbox). `AmqpConnection.isConnected()` serve para readiness
  do worker/notification, se desejado.
- A cada (re)conexão declara a topologia do contrato (`assertTopology: false` desliga, para
  confiar só no one-shot `rabbitmq-init`, que pode usar `setupTopology({ url })`).
- Métricas: usa o `METRICS_REGISTRY` do `MetricsServerModule` (importe os dois no módulo raiz).

Opções (`MessagingModuleOptions`): `url`, `connectionName`, `assertTopology` (padrão `true`),
`topology` (só testes: TTLs curtos), `confirmTimeoutMs` (5000), `heartbeatIntervalInSeconds`
(15), `reconnectTimeInSeconds` (5), `shutdownTimeoutMs` (30000).

### Escrever um consumidor (camada `interfaces`)

```ts
@Injectable()
export class VideoUploadedConsumer implements OnApplicationBootstrap {
  constructor(
    private readonly consumers: MessageConsumers,
    private readonly processVideo: ProcessVideoUseCase,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.start({
      queue: QUEUES.workerVideoUploaded,         // nunca string solta
      schema: videoUploadedEvent,               // envelope validado com zod antes do handler
      prefetch: this.config.WORKER_PREFETCH,
      // Efeito durável; resolveu → ack. Roda dentro de runWithCorrelation(event.correlationId).
      handle: (event, context) => this.processVideo.execute(event.payload, context.retryCount),
      // NonRetryableError (P0001...) é resultado de negócio: publica e dá ack (sem retry).
      onPermanentFailure: (event, error, context) =>
        this.publisher.publishEvent(
          createEvent(
            'video.processing.failed',
            {
              videoId: event.payload.videoId,
              attempt: context.retryCount + 1,
              errorCode: error.appError.code,
              errorMessage: error.appError.description,
            },
            event.correlationId,
          ),
        ),
    });
  }
}
```

O que o `ConsumerRunner` faz com o resultado do `handle` (contratos.md, "Regras de consumo"):

| Resultado do `handle` | Ação no broker | `fiapx_messages_consumed_total{result}` |
|---|---|---|
| resolveu | `ack` | `success` |
| `RetryableError` **ou erro desconhecido**, `x-retry-count < 3` | cópia em `<fila>.retry.<n+1>` (default exchange, confirm, `x-retry-count=n+1`, `x-last-error`, sem headers `x-death`), depois `ack` | `retry` |
| idem, `x-retry-count = 3` | `nack(requeue=false)` → `fiapx.dlx` → `<fila>.dlq` (e `api.video-deadletter`, no caso do worker) | `dead_letter` |
| `NonRetryableError` | `onPermanentFailure` (se houver) e `ack`; se o `onPermanentFailure` falhar, segue o caminho de retry | `permanent_failure` |
| envelope inválido (JSON/zod) | `nack(requeue=false)` → DLX, handler não é chamado | `invalid` |
| cópia de retry sem confirm (broker instável) | `reject(requeue=true)` (no RabbitMQ 4.3 o `basic.reject` conta no `x-delivery-limit`; o `basic.nack` com requeue não contaria) | `requeued` |
| crash / canal fechado sem ack | o broker reentrega (`context.redelivered`, `context.deliveryCount`); na 6ª entrega vai ao DLX com `x-last-death-reason=delivery_limit` | — |

`MessageContext` traz `queue`, `messageId` (= `event.id`, chave de `processed_messages`),
`correlationId`, `retryCount`, `deliveryCount`, `redelivered`, `deathReason` e `headers`.
No consumidor de `api.video-deadletter`, `deathReason` diz por que a mensagem morreu no worker
(`rejected` = retries esgotados, `delivery_limit` = crash-loop), mas **só na 1ª tentativa**
(`retryCount = 0`): a cópia de retry sai sem os headers `x-death` e, ao voltar da `.retry.N`,
o motivo passa a ser `expired`. O contrato marca `P0099` em qualquer caso, então isso só afeta
logs/diagnóstico.

**SIGTERM**: `MessageConsumers.onModuleDestroy` cancela os consumers, espera as mensagens em
processamento até `shutdownTimeoutMs` e fecha os canais; só depois (`onApplicationShutdown`) o
Nest fecha banco e conexão AMQP. O que ficar sem ack volta para a fila.

### Publicar

Casos de uso dependem da porta, não do adaptador:

```ts
constructor(@Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher) {}

await this.publisher.publishEvent(
  createEvent('video.processing.started', { videoId, attempt, workerId }, correlationId),
);
```

`publishEvent` valida com `EVENT_SCHEMAS[event.type]` (fora do contrato → `InvalidEventError`,
nada é publicado) e publica no `fiapx.events` com routing key = `type`, `persistent`,
`mandatory`, `messageId = event.id`, `correlationId`, `type`, `contentType: application/json`,
`timestamp`, `appId` e header `x-correlation-id`. **Resolve só depois do publisher confirm.**
Erros: `UnroutableMessageError` (nenhuma fila ligada à routing key), `PublishError` (nack,
timeout do confirm, canal fechado; `cause` tem o detalhe). O outbox relay do `video-api` trata
qualquer erro como "tente de novo depois".

Ids determinísticos (worker sem banco): `createEvent(type, payload, correlationId, { id })`.

### Testar sem broker (`@fiapx/messaging/testing`)

```ts
const publisher = new RecordingEventPublisher();          // valida como o real
await useCase.execute(...);
expect(publisher.ofType('video.processing.failed')).toHaveLength(1);
publisher.failNextWith(new PublishError('fiapx.events', 'video.uploaded'));  // broker fora

// Handler direto:
await definition.handle(videoUploadedFixture, messageContext(videoUploadedFixture, { retryCount: 1 }));

// Regras de ack/retry de ponta a ponta, sem RabbitMQ:
const channel = new RecordingAckChannel();
await runner.handleDelivery(channel, consumeMessageFor(videoUploadedFixture));
```

## Storage (`@fiapx/storage`)

```ts
StorageModule.forRootAsync({
  inject: [WORKER_CONFIG],
  useFactory: (config: WorkerConfig) => storageOptionsFromConfig(config),
}),

constructor(
  @Inject(OBJECT_STORAGE) private readonly storage: IObjectStorage,
  @Inject(STORAGE_BUCKETS) private readonly buckets: StorageBuckets,   // { raw, zips }
) {}
```

| Método | Comportamento |
|---|---|
| `putStream({ bucket, key, body, contentType?, metadata?, signal? })` | Upload multipart em stream (`lib-storage`, partes de 8 MiB, 2 em paralelo) → `{ sizeBytes, etag }`. `metadata` vira `x-amz-meta-*` (ex.: `{ 'video-id': id, 'frame-count': '3' }`). `signal` aborta (cliente desconectou). |
| `getStream(bucket, key)` | `{ body: Readable, sizeBytes, contentType, etag, lastModified, metadata }` (download em stream) |
| `head(bucket, key)` | Metadados. Objeto inexistente → `ObjectNotFoundError` |
| `exists(bucket, key)` | `false` **só** para inexistente; outras falhas propagam |
| `delete(bucket, key)` | Idempotente |
| `checkBucket(bucket)` | Readiness (bucket existe e a credencial vale) |

Erros: `ObjectNotFoundError` (404) e `ObjectStorageError` (rede, 5xx, credencial; com
`operation`, `bucket`, `key` e `cause`). No worker: `ObjectNotFoundError` → `P0005`,
`ObjectStorageError` → `RetryableError`. Chaves: `rawVideoKey(userId, videoId, ext)` e
`zipKey(userId, videoId)`. Teste: `InMemoryObjectStorage` (`@fiapx/storage/testing`), com
`failNext('put' | 'get' | 'head' | 'delete' | 'checkBucket')`.

## Banco (`@fiapx/common`, TypeORM)

```ts
TypeOrmModule.forRootAsync({
  inject: [API_CONFIG],
  useFactory: (config: ApiConfig) =>
    createTypeOrmOptions(config, {
      applicationName: SERVICE_NAME,
      entities: [UserOrmEntity, VideoOrmEntity],
      migrations: [Init1760000000000],   // lista EXPLÍCITA, sem glob
    }),
}),
```

`synchronize`, `migrationsRun` e `dropSchema` ficam fixos em `false`; TLS só com `DB_SSL=true`
(com verificação do certificado). Migrações rodam por um one-shot:
`await runMigrations(createDataSource(config, { ... }))` (cada migração na própria transação;
devolve os nomes aplicados; idempotente).

Validação de entrada HTTP: `@Body(new ZodValidationPipe(schema))` → `400 X0001 VALIDATION` com
`metadata.fields = [{ field, message }]`.

## Testes de integração (`npm run test:int`)

- Arquivos `apps/<app>/test/*.int-spec.ts` ou `libs/<lib>/test/*.int-spec.ts`: entram sozinhos
  no `jest.int.config.js`.
- `@fiapx/testing`: `startRabbitMq()`, `startPostgres(db)`, `startRedis()`, `startGarage()`
  (mesmo `garage.toml` e `init.mjs` do compose), `waitFor(probe)`, `delay(ms)`,
  `quietNestLogs()` (`INT_LOGS=1` mostra os logs). As imagens vêm do `compose.yaml` (tag +
  digest) e as credenciais são aleatórias por execução.
- Precisa de Docker (OrbStack local; runner do GitHub no CI, job `integration`).
- TTLs curtos só em broker descartável: `buildTopology({ retryDelaysMs: [300, 600, 900] })`
  (em broker com as filas de produção isso dá `PRECONDITION_FAILED`, de propósito).

## Observabilidade (`@fiapx/observability`)

- `createPinoConfig({ serviceName, version, level })` para o `LoggerModule` (nestjs-pino): JSON
  por linha, `correlationId` em todo log, redação LGPD (`REDACTED_PATHS`) e log de acesso enxuto
  (`serializeAccessRequest`: id, método, caminho **sem query string**, IP; `serializeAccessResponse`:
  só o status). Health, métricas e docs não geram log de acesso.
- `MetricsServerModule.forRootAsync(...)` (global, só no módulo raiz): `/health` e `/metrics`
  (Bearer `METRICS_TOKEN`) em `METRICS_PORT`; os demais módulos injetam `METRICS_REGISTRY`.
- `createHttpMetricsMiddleware(registry)`: histograma `fiapx_http_request_duration_seconds`
  (`configureApp` do video-api o registra).
- `correlationIdMiddleware`, `runWithCorrelation(id, fn)` e `getCorrelationId()`.

## Dependências já instaladas (não mexer no `package.json` nas etapas E3-E5)

Runtime: `@nestjs/typeorm` 11 + `typeorm` 1.1 + `pg`, `@nestjs/jwt`, `@nestjs/passport` +
`passport` + `passport-jwt`, `bcryptjs`, `busboy`, `file-type`, `helmet`, `@nestjs/throttler` +
`@nest-lab/throttler-storage-redis` + `ioredis` 5, `@aws-sdk/client-s3` + `@aws-sdk/lib-storage`,
`archiver` 7, `amqp-connection-manager` + `amqplib`, `resend`, `nodemailer`, `@nestjs/schedule`,
`@nestjs/serve-static`, `uuid` 11, `zod`. Métricas: `@prometheus-io/client` (sucessor do
`prom-client`, já usado pelo `libs/observability`). Dev: `testcontainers` (+ módulos rabbitmq,
postgresql, redis), `jest-cucumber`, `supertest`, `lint-staged` + `simple-git-hooks` (pre-commit)
e os `@types/*` necessários.

`file-type` é só ESM: em produção o Node 22 carrega via `require(esm)`; no Jest, o
`jest.preset.js` converte para CommonJS (`ESM_ONLY_PACKAGES`). Pode importar normalmente:
`import { fileTypeFromBuffer } from 'file-type'`.
