# ADR-0003: RabbitMQ com filas quorum, retry por filas e DLQ

- Status: aceita
- Data: 2026-09-28

## Contexto

O processamento precisa de uma **fila de trabalho**: cada vídeo é processado por um único
worker, confirmado mensagem a mensagem, com várias réplicas competindo pela mesma fila, retry
com atraso para falhas transitórias e um destino final para o que não tem conserto. Nada pode
se perder num restart do broker. O enunciado sugere RabbitMQ ou Kafka.

Na fase anterior do curso, o retry por `nack(requeue=true)` devolvia a mensagem idêntica, o
contador de tentativas nunca avançava e a mensagem girava em loop sem chegar à DLQ.

## Decisão

- **RabbitMQ 4.3** (imagem fixada por digest), vhost `/`.
- Exchanges `fiapx.events` (topic, todos os eventos) e `fiapx.dlx` (direct, dead-letter com
  routing key igual ao nome da fila de origem).
- Filas principais `worker.video-uploaded`, `api.video-processing`, `api.video-deadletter` e
  `notification.events`, todas **quorum** e duráveis, com `x-delivery-limit=5`,
  `x-dead-letter-exchange=fiapx.dlx`, `x-dead-letter-strategy=at-least-once` e
  `x-overflow=reject-publish`.
- **Retry por filas**: cada fila principal tem `.retry.1`, `.retry.2` e `.retry.3` com TTL fixo
  de 5 s, 30 s e 120 s. Falha transitória → cópia com `x-retry-count = n+1` publicada (com
  confirm) direto na `.retry.N` pela default exchange, e só então `ack` do original; ao expirar,
  a cópia volta para a fila de origem. Esgotou → `nack(requeue=false)` → DLX → `.dlq`.
- Erro permanente não gasta retry: vira resultado de negócio (ex.: `video.processing.failed`).
- **Dependência fora do ar** (Postgres, storage, provedor de e-mail) não é culpa da mensagem:
  `nack` com requeue (não conta no `x-delivery-limit`) e o consumidor pausa com backoff de 5 s a
  60 s, sem gastar retry e sem mandar nada para a DLQ.
- Mensagens mortas de `worker.video-uploaded` também vão para `api.video-deadletter`: o
  `video-api` marca o vídeo `FAILED` (`P0098` se os retries esgotaram, `P0099` se foi crash em
  loop) e o usuário é avisado. Quem chega por dead-letter ou redrive começa um ciclo novo de
  retries.
- **Publisher confirms** em toda publicação (`persistent`, `mandatory`, `messageId`,
  `correlationId`, `type`, `timestamp`), prefetch 1 no worker, 10 no api e 5 no notificador.
- **Topologia em código** (`libs/messaging/src/topology.ts`): no K8s, criada pelo Job
  `rabbitmq-init` antes dos apps (initContainer com o `setup-topology.js` da imagem do
  `video-api`) e redeclarada de forma idempotente por cada serviço a cada conexão; no compose, os
  serviços a criam. Mudar argumento de fila existente falha com `PRECONDITION_FAILED` de propósito
  (exige migração de fila).
- No K8s, o Job `rabbitmq-init` também cria **um usuário por serviço** (`fiapx-api`,
  `fiapx-worker`, `fiapx-notification`) com permissões mínimas e *topic permissions* (cada um só
  publica as routing keys que são dele), o usuário de monitoramento do KEDA (sem permissão sobre
  mensagens) e as operator policies `fiapx-limits` (64 MiB por fila) e `fiapx-dlq-limits` (DLQs
  com TTL de 7 dias e `reject-publish`). O plugin shovel permite o redrive das DLQs pela UI.

## Consequências

**Positivas (+)**

- Semântica nativa de fila de trabalho: ack por mensagem, prefetch, competing consumers e DLX.
- Filas quorum gravam em disco (Raft) e já estão prontas para um cluster de 3 nós.
- TTL fixo **por fila** evita o bloqueio da cabeça da fila (uma mensagem de 120 s não segura as
  de 5 s atrás dela).
- O contador de retry sempre avança: não existe loop infinito (teste de regressão contra um
  RabbitMQ real).
- Tudo visível na UI de management (filas `.retry.N` e `.dlq`), e o KEDA tem scaler nativo.

**Negativas (−)**

- Entrega at-least-once: todo consumidor precisa ser idempotente (ADR-0004).
- 20 filas para entender (4 principais × 5); atrasos de retry fixos (mudar exige migrar filas).
- Broker de nó único nesta VM (sem alta disponibilidade).

## Alternativas rejeitadas

| Alternativa | Por que não |
|---|---|
| Kafka | log particionado: paralelismo preso ao número de partições, sem ack por mensagem nem DLQ nativos, retry com tópicos feitos à mão; JVM pesada para a VM e para esta vazão |
| BullMQ (Redis) | tornaria o Redis um armazenamento crítico e durável, que aqui é só cache; seria um segundo "broker" |
| Retry com `nack(requeue=true)` | devolve a mensagem idêntica, sem atraso e sem contador: foi o bug da fase anterior |
| Uma fila de atraso única com TTL por mensagem | bloqueio da cabeça da fila: mensagens com TTL curto esperam as de TTL longo |
| Filas clássicas | menos garantias de durabilidade e sem `x-delivery-limit` |

## Onde está

- `libs/messaging/src/topology.ts`, `retry-decision.ts`, `headers.ts`
- `libs/messaging/src/consumer/consumer-runner.ts` e `publisher/message-publisher.ts`
- `libs/messaging/test/messaging.int-spec.ts` (regressão do retry, poison message, dependência fora, topologia)
- `infra/k8s/base/data/rabbitmq/` (StatefulSet, `rabbitmq-init.mjs`) e `infra/k8s/jobs/rabbitmq-init.yaml`
- `apps/video-api/src/setup-topology.ts` (criação da topologia no Job)
- [`docs/arquitetura.md`](../arquitetura.md), seção 6
