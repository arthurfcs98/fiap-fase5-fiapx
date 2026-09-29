# ADR-0002: TypeScript/NestJS também no worker

- Status: aceita
- Data: 2026-09-28

## Contexto

O projeto base é em Go e o worker poderia continuar em Go. Mas o trabalho pesado do worker não
é código Go nem Node: é o **ffmpeg**, um binário nativo chamado como processo filho. O código do
worker em si é orquestração (baixar o vídeo, chamar `ffprobe`/`ffmpeg`, montar o zip em stream,
publicar eventos, tratar falhas), exatamente o que as libs compartilhadas já fazem para os
outros serviços.

A API e o notificador são NestJS, e a equipe domina TypeScript, NestJS e Jest das fases
anteriores do curso.

## Decisão

- Reescrever o worker em **TypeScript/NestJS**, com a mesma estrutura dos outros serviços.
- Manter a **semântica do projeto base**: `ffmpeg -i <vídeo> -vf fps=1`, saída
  `frame_%04d.png`, zip com todos os frames, mesmas extensões aceitas.
- Chamar `ffprobe` e `ffmpeg` como processos filhos com argumentos explícitos e endurecidos:
  `-nostdin`, `-protocol_whitelist file` (um arquivo malicioso não faz o ffmpeg abrir URLs),
  `-format_whitelist` só com os contêineres de vídeo aceitos, `-threads 2`, `nice -n 10`, timeout
  por execução e classificação do resultado (código de saída, sinal, disco cheio) em erro
  transitório ou permanente.
- Limitar a saída, que é o que enche o disco: no máximo 1 frame por segundo de
  `MAX_VIDEO_DURATION_S` (`-frames:v`, vale mesmo sem duração no cabeçalho), lado maior de até
  1920 px e, enquanto o ffmpeg roda, a pasta dos frames medida a cada 1 s contra `MAX_FRAMES_MB`
  (passou: o ffmpeg para e o vídeo termina `FAILED P0006`, em vez de o kubelet despejar o pod por
  `emptyDir` cheio).
- Parar o trabalho quando a entrega se perde: se o canal que entregou a mensagem fecha, o sinal de
  abort da entrega mata o ffmpeg e aborta as transferências; cada execução usa a própria pasta
  (`/work/{videoId}/{runId}`).
- A imagem do worker é a mesma do Dockerfile único, com `WITH_FFMPEG=true` (ffmpeg do Alpine
  fixado pelo digest da base).
- O código Go original fica intacto em `legacy/projeto-base/` como o "antes".

## Consequências

**Positivas (+)**

- Uma toolchain só: lint, testes, cobertura, Dockerfile e CI iguais para os 3 serviços.
- O worker usa as mesmas libs: `@fiapx/messaging` (retry, DLQ, confirms), `@fiapx/contracts`
  (os mesmos schemas do envelope), `@fiapx/storage` e `@fiapx/observability` (logs, métricas e
  correlation id idênticos).
- Testes de integração com **ffmpeg real** no mesmo Jest (vídeo válido, corrompido, só áudio,
  longo demais, sem duração no cabeçalho, 4K reduzido a 1920 px, `MAX_FRAMES_MB`, entrega
  abandonada no meio, timeout).

**Negativas (−)**

- A imagem do worker (Node + ffmpeg) é maior que um binário Go estático e o processo usa mais
  memória de base.
- O ganho de desempenho de Go seria irrelevante aqui: o tempo é gasto dentro do ffmpeg.

## Alternativas rejeitadas

| Alternativa | Por que não |
|---|---|
| Manter o worker em Go | segundo stack de build, teste e CI; as regras de retry/DLQ e o envelope teriam de ser reimplementados e mantidos em duas linguagens |
| Biblioteca wrapper do ffmpeg | esconde os argumentos, o tratamento de sinais e o timeout, justamente o que o worker precisa controlar |
| ffmpeg compilado para WebAssembly dentro do Node | mais lento e sem ganho de isolamento em relação a um processo filho não-root com teto de CPU e memória |

## Onde está

- `apps/video-worker/src/modules/processing/infrastructure/ffmpeg/ffmpeg-video-toolkit.ts` (argumentos e classificação)
- `apps/video-worker/src/modules/processing/infrastructure/process/process-runner.ts` (timeout e sinais)
- `apps/video-worker/src/modules/processing/application/failure-classifier.ts`
- `apps/video-worker/test/ffmpeg-pipeline.int-spec.ts` e `video-worker.int-spec.ts`
- `legacy/projeto-base/main.go`
