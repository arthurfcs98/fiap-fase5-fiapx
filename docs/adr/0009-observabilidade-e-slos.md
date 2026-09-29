# ADR-0009: Prometheus, Grafana, Loki e Alloy, com SLOs

- Status: aceita
- Data: 2026-09-28

## Contexto

Um upload atravessa HTTP, banco, outbox, broker, worker, ffmpeg, storage e e-mail, em três
serviços. Sem observabilidade, "meu vídeo sumiu" não tem resposta. O enunciado sugere
Prometheus + Grafana (ou ELK). A VM tem pouca memória sobrando, e os logs não podem carregar
dados pessoais (ADR-0010). Não há contrato de nível de serviço (SLA), mas é preciso saber se o
sistema está saudável.

## Decisão

- **Métricas**: `@prometheus-io/client` (sucessor oficial do `prom-client`) num servidor interno
  `:9464/metrics` protegido por Bearer em cada serviço; histograma HTTP por rota e métricas de
  negócio `fiapx_*` (uploads, concluídos, falhas por `error_code`, tempo do upload ao resultado,
  outbox pendente, bytes de zips guardados, duração do processamento, jobs do worker, mensagens
  consumidas, e-mails). **Prometheus v3** com descoberta por anotação restrita ao namespace
  `fiapx`, retenção de 3 dias ou 400 MB; coleta também RabbitMQ, Garage, KEDA e CPU/memória dos
  pods.
- **Logs**: pino JSON no stdout com `correlationId`, `service` e `level`, dados pessoais
  mascarados na origem. **Grafana Alloy** (DaemonSet; o Promtail foi descontinuado) lê os logs
  **pela API do Kubernetes** (o Pod Security do namespace proíbe montar o disco do nó) e envia ao
  **Loki** (single binary, 72 h). Rótulos só `namespace`, `app` e `level`; o `correlationId` vai
  como *structured metadata* (filtrável sem explodir a cardinalidade).
- **Rastreamento**: o `correlationId` do header `x-correlation-id` atravessa HTTP → outbox →
  AMQP → worker → e-mail (até o cabeçalho `X-Correlation-Id` do e-mail).
- **Grafana 12** com datasources e 2 dashboards provisionados como código (`fiapx-pipeline` e
  `fiapx-slos`), sem volume e **sem Ingress** (acesso só por port-forward).
- **SLOs** numa janela de 7 dias, com regras de gravação do SLI e do orçamento de erro:
  disponibilidade ≥ 99,5%, p95 do upload < 5 s, p95 do processamento < 120 s, 95% dos vídeos
  concluídos até 300 s depois do upload (com a espera na fila) e sucesso do pipeline ≥ 99%; mais
  a meta "nenhuma requisição perdida" (DLQs vazias, outbox < 100).
- **10 alertas** (disponibilidade por taxa de queima em duas janelas, latência do upload,
  processamento lento, DLQ com mensagem, outbox acumulado, fila crescendo, fila principal sem
  consumidor, zips perto da quota, worker fora, alvo fora), com 17 testes unitários das regras
  (`promtool test rules`) no CI.
- **Saúde dos consumidores**: o consumidor cancelado pelo broker se re-assina sozinho; se ficar
  60 s sem consumir com o broker conectado, o `/health` interno do worker e do notificador
  responde 503 e a liveness do Kubernetes reinicia o pod (no `video-api`, só o alerta
  `FiapxQueueWithoutConsumer` avisa).

## Consequências

**Positivas (+)**

- Três sinais por 225m de CPU e 544Mi de memória pedidos, dentro da quota do namespace.
- Tudo como código e validado no CI (`promtool`, `loki -verify-config`, `alloy validate`).
- Um único id responde "onde está meu vídeo?" no Loki, do upload ao e-mail.
- Alertas por taxa de queima do orçamento de erro disparam quando o ritmo de falha ameaça o SLO,
  e não por um pico isolado.

**Negativas (−)**

- Sem Alertmanager: os alertas aparecem no Grafana/Prometheus, mas ninguém é notificado.
- Um Prometheus e um Loki, sem réplica (na queda, perde-se a observação do período, nunca dado
  de negócio).
- Retenção de métricas (3 dias) menor que a janela dos SLOs (7 dias).
- Sem spans de tracing distribuído; acesso ao Grafana só com root na VM (port-forward).

## Alternativas rejeitadas

| Alternativa | Por que não |
|---|---|
| ELK/EFK | Elasticsearch pede mais memória do que a VM tem sobrando |
| Promtail | descontinuado; o Alloy é o sucessor oficial |
| `prom-client` | substituído pelo `@prometheus-io/client` |
| `correlationId` como rótulo do Loki | um stream por requisição: explosão de cardinalidade |
| Observabilidade SaaS | dados (mesmo mascarados) fora do ambiente, contas e custo |
| OpenTelemetry + Tempo agora | mais componentes; o `correlationId` cobre a investigação (fica como evolução) |

## Onde está

- `infra/k8s/observability/` (Prometheus, regras, testes, Loki, Alloy, Grafana, dashboards)
- `libs/observability/` (pino, redação, correlation id, métricas e `/health` internos)
- [`docs/observabilidade.md`](../observabilidade.md) (consultas, SLOs, runbook de cada alerta)
