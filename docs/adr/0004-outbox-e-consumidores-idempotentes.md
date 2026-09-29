# ADR-0004: Transactional Outbox e consumidores idempotentes

- Status: aceita
- Data: 2026-09-28

## Contexto

O upload precisa gravar o vídeo no banco **e** publicar `video.uploaded`. São dois sistemas sem
transação comum (dual write):

- commit e depois publicar: se o processo cair ou o broker estiver fora entre os dois, o vídeo
  fica `QUEUED` para sempre e ninguém o processa;
- publicar e depois commit: o worker pode receber um vídeo que o banco não tem.

O mesmo vale para `COMPLETED`/`FAILED` (que disparam o e-mail) e para a eliminação de conta
(que dispara a anonimização). E, como o broker entrega **pelo menos uma vez**, toda mensagem
pode chegar duplicada.

## Decisão

- **Transactional Outbox no `video-api`**: o evento é gravado em `outbox_events` na **mesma
  transação** do dado (upload, transição terminal, eliminação de conta). O `video-api` nunca
  publica direto numa requisição.
- **Relay** a cada 500 ms (drena lotes cheios em seguida): `SELECT ... FOR UPDATE SKIP LOCKED`
  de até 50 linhas com lease em `locked_until` (30 s), publica cada uma com publisher confirm e
  marca `published_at`. Nenhuma publicação começa nos últimos 10 s do lease (o resto do lote é
  devolvido), então duas réplicas não publicam a mesma linha em operação normal. Falha de
  publicação → backoff exponencial de 1 s até 60 s e o resto do lote é liberado. O `id` da linha
  é o `messageId` do AMQP.
- **Consumidores idempotentes**, cada um com a técnica que cabe no seu dado:
  - `video-api`: inbox `processed_messages (message_id, consumer)` gravada na mesma transação da
    transição, mais a guarda da máquina de estados (transição inválida é ignorada);
  - `video-worker` (sem banco): chave do zip determinística; um `HEAD` antes de processar
    detecta trabalho já feito e só republica `completed`; os ids dos eventos que ele publica são
    UUID v5 derivados do `messageId` de origem, então uma republicação tem o mesmo id e cai na
    inbox do `video-api`;
  - `notification-service`: `dedup_key` única (`INSERT ... ON CONFLICT DO NOTHING`) e o id da
    notificação enviado como `Idempotency-Key` ao provedor de e-mail; um evento de quem já
    excluiu a conta encontra o id em `deleted_users` e é descartado (LGPD);
  - em todos, dentro do processo, entregas com o mesmo `messageId` rodam uma depois da outra (a
    reentrega espera a anterior terminar).
- Observação: gauge `fiapx_outbox_pending` e alerta `FiapxOutboxBacklog` (≥ 100 por 5 min).
- Linhas publicadas são apagadas depois de 7 dias (o payload tem e-mail e nome; LGPD).

## Consequências

**Positivas (+)**

- RabbitMQ fora do ar não bloqueia o upload nem perde o evento: ele espera no banco. O readiness
  do `video-api` nem depende do broker.
- Várias réplicas do `video-api` publicam sem duplicar trabalho (`SKIP LOCKED` + lease).
- Estado e evento mudam juntos ou não mudam: não existe vídeo concluído sem o evento do e-mail.
- Mensagens repetidas (retry, crash, redrive) não corrompem o estado nem mandam e-mail em dobro.

**Negativas (−)**

- Latência extra de até ~500 ms entre o commit e a publicação.
- Mais tabelas e jobs (outbox, inbox, limpeza periódica).
- A ordem entre eventos do mesmo vídeo não é garantida (ex.: `completed` antes de `started`); a
  máquina de estados aceita isso explicitamente.

## Alternativas rejeitadas

| Alternativa | Por que não |
|---|---|
| Publicar depois do commit, sem outbox | perde o evento se o processo cair ou o broker estiver fora |
| Transação distribuída (2PC/XA) | o RabbitMQ não participa de XA; complexidade e bloqueio |
| CDC (Debezium lendo o WAL) | exige Kafka Connect e mais componentes: pesado demais para a VM |
| Deduplicar só por cache em memória | some no restart e não é compartilhado entre réplicas |

## Onde está

- `apps/video-api/src/modules/outbox/` (relay, store, scheduler, métrica)
- `apps/video-api/src/modules/videos/application/use-cases/upload-video.use-case.ts` e `apply-processing-event.use-case.ts`
- `apps/video-api/src/shared/infrastructure/database/typeorm-processed-messages.ts` (inbox)
- `apps/video-worker/src/modules/processing/application/event-ids.ts` (ids determinísticos)
- `apps/notification-service/src/modules/notifications/application/use-cases/send-video-notification.use-case.ts`
