# ADR-0007: KEDA pelo tamanho da fila no worker e HPA por CPU no api

- Status: aceita
- Data: 2026-09-28

## Contexto

O requisito "processar mais de um vídeo ao mesmo tempo" pede mais réplicas do worker quando há
trabalho acumulado. O sinal certo para o worker é a **fila**, não a CPU: um worker processando
um único vídeo já fica com a CPU no teto (o ffmpeg usa o que tiver), então CPU alta não diz se
há vídeos esperando. Já o `video-api` é limitado por CPU e latência das requisições.

Na VM compartilhada, o teto é de 2 workers de 1 vCPU (para proteger os vizinhos, ADR-0006).

## Decisão

- **KEDA** (instalado pelo root no namespace `keda`) com um `ScaledObject` para o
  `video-worker`:
  - trigger `rabbitmq`, `mode: QueueLength`, `value: "1"` (uma mensagem por réplica, igual ao
    prefetch 1) na fila `worker.video-uploaded`;
  - `protocol: http` (API de management): o KEDA enxerga as mensagens **prontas e em
    processamento**; pelo AMQP ele só veria as prontas, e 1 vídeo em processamento + 1 na fila
    daria 1 réplica em vez de 2 (ou um scale-in poderia mirar o worker ocupado);
  - mínimo 1 e máximo 2 réplicas; scale-down com estabilização de 120 s, uma réplica por minuto;
  - credencial própria (`fiapx-keda`, tag `monitoring`, sem permissão de ler ou publicar
    mensagens), criada pelo Job `rabbitmq-init`.
- **HPA** no `video-api`: 1 a 2 réplicas por CPU (70% do request), scale-down com estabilização
  de 300 s.
- O worker usa estratégia `Recreate` e 720 s de grace period (no SIGTERM termina o vídeo em
  curso inteiro: ffprobe + ffmpeg + transferências nos tempos máximos) e a menor prioridade do
  namespace (`fiapx-lote`): sob pressão ele sai primeiro e a mensagem volta para a fila.
- No `video-api`, cada usuário tem no máximo 5 vídeos em andamento (`429 V0007` com
  `Retry-After` acima disso): a escala atende muitos usuários, e um usuário sozinho não ocupa
  todos os workers.

## Consequências

**Positivas (+)**

- Escala pelo sinal real de demanda; o KEDA gera um HPA comum (`keda-hpa-video-worker`), visível
  com `kubectl get hpa`.
- Mínimo 1: sem partida a frio do primeiro vídeo.
- Na VM, a escala é limitada pelo orçamento, não pela arquitetura: num cluster dedicado basta
  subir o `maxReplicaCount` (no compose, `--scale video-worker=N`).

**Negativas (−)**

- Com no máximo 2 réplicas, um pico grande vira espera na fila (esperado; alerta
  `FiapxQueueBacklogHigh`), não mais vazão.
- Um componente a mais (KEDA, CRDs, APIService de métricas externas).
- Reação em dezenas de segundos (consulta a cada 15 s + subida do pod).

## Alternativas rejeitadas

| Alternativa | Por que não |
|---|---|
| HPA por CPU no worker | CPU no teto com um único vídeo; não mede a fila acumulada |
| Réplicas fixas | desperdício fora do pico ou falta no pico |
| Escalar até zero | partida a frio a cada primeiro vídeo; o ganho de memória não compensa com mínimo tão baixo |
| KEDA pelo protocolo AMQP | enxerga só mensagens prontas (ver acima) |

## Onde está

- `infra/k8s/base/apps/video-worker/scaledobject.yaml` e `triggerauthentication.yaml`
- `infra/k8s/base/apps/video-api/hpa.yaml`
- `infra/vm/35-keda.sh` e `infra/vm/k8s/keda-helmchart.yaml`
- `tests/bdd/features/04-pico.feature` (pico com 3 workers no compose)
