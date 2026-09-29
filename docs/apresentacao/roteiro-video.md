# Roteiro do vídeo de apresentação (até 10 minutos)

> Alvo: **9:00 a 9:30** (limite do enunciado: 10:00). O enunciado pede que o vídeo mostre a
> **documentação**, a **arquitetura escolhida** e o **projeto funcionando**. Este roteiro faz os
> três, com o sistema em produção em <https://frames.asdevit.com>.
>
> Regra de ouro da gravação: **nenhuma senha, token, IP da VM ou e-mail pessoal aparece na
> tela.** Senhas são lidas sem eco (`read -rs`) ou copiadas direto para a área de transferência;
> a conta da demo usa uma caixa de e-mail de teste criada só para isso.

## Mensagem central (se só uma coisa ficar)

1. O upload responde **`202` na hora** e o processamento vai por **fila**: pico vira fila, não
   erro, e **nenhum pedido se perde** (outbox, filas quorum, retry, DLQ).
2. Os vídeos são processados **em paralelo** por workers que **escalam pelo tamanho da fila**
   (KEDA), e o usuário é **avisado por e-mail** quando algo falha.
3. Tudo é **código, testado e implantado automaticamente**: CI com testes reais, deploy com
   rollback, observabilidade e LGPD desde o desenho.

## Linha do tempo

| # | Tempo | Bloco | Tela principal |
|---|---|---|---|
| 1 | 0:00-0:30 | Abertura | README no GitHub |
| 2 | 0:30-1:30 | Antes e depois | `legacy/projeto-base/main.go` e `docs/arquitetura.md` §1.2 |
| 3 | 1:30-3:00 | Arquitetura | `docs/arquitetura.md` §2.2, §3.1, §6.2 e `docs/adr/` |
| 4 | 3:00-5:00 | Demo: processamento, download e falha com e-mail | <https://frames.asdevit.com> e caixa de e-mail de teste |
| 5 | 5:00-6:30 | Demo: pico, fila e KEDA | terminal, RabbitMQ, `kubectl`, Grafana |
| 6 | 6:30-7:15 | Observabilidade | Grafana (Loki e SLOs) |
| 7 | 7:15-8:30 | Qualidade e CI/CD | GitHub Actions e features BDD |
| 8 | 8:30-9:00 | Segurança e LGPD | frontend "Meus dados" e terminal |
| 9 | 9:00-9:20 | Encerramento | `docs/arquitetura.md` §12 |

## Roteiro detalhado

As falas são sugestões para ler em voz natural (cerca de 140 palavras por minuto). Os tempos já
contam as esperas da demo.

### 1. Abertura (0:00-0:30)

**Tela:** README do repositório no GitHub, rolando até a seção "Arquitetura". (Se a equipe
tiver mais integrantes, apresente todos nesta abertura.)

> "Olá, eu sou o Arthur, da turma 14SOAT. Este é o FIAP Frames, a solução do hackathon da
> Fase 5. A FIAP X tinha um protótipo que extrai os frames de um vídeo e precisava de um sistema
> que atenda muitos usuários, não perca pedidos em pico e avise quando algo dá errado. Vou
> mostrar a documentação, a arquitetura e o sistema funcionando em produção, em
> frames.asdevit.com."

### 2. Antes e depois (0:30-1:30)

**Tela:** `legacy/projeto-base/main.go` no GitHub com as linhas 75 a 124 destacadas
(`#L75-L124`); depois `docs/arquitetura.md`, seção 1.2 (tabela).

> "Este é o projeto base, em Go. O upload chama o ffmpeg dentro da própria requisição, na linha
> 117: o usuário fica esperando e um pico dispara vários ffmpeg ao mesmo tempo. Os nomes usam
> um carimbo com precisão de segundo, então dois uploads no mesmo segundo se misturam. O
> download não tem dono e as pastas são públicas. Não há usuário, banco nem aviso de erro, e o
> Dockerfile compila o código a cada start, como root. Nesta tabela está cada problema, a linha
> onde ele aparece e como foi resolvido: resposta 202 com processamento por fila, UUID por
> vídeo, login com JWT e link de download assinado, buckets privados, banco e fila
> persistentes, e-mail na falha e uma imagem mínima que não roda como root."

### 3. Arquitetura (1:30-3:00)

**Tela:** `docs/arquitetura.md` §2.2 (diagrama de containers) → §3.1 (implantação) → §6.2
(retry e DLQ) → `docs/adr/README.md`.

> "São três microsserviços NestJS num monorepo. O video-api cuida de login, upload, status e
> download; o video-worker roda o ffmpeg; e o notification-service manda o e-mail. Eles
> conversam por eventos no RabbitMQ. Os dados ficam no PostgreSQL, um banco por serviço; os
> arquivos, num storage compatível com S3, o Garage; e o Redis guarda o limite de tentativas e o
> cache de idempotência.
>
> Em produção, tudo roda num K3s de nó único, numa VM que já hospeda outros projetos. Por isso
> há quota de recursos, discos dedicados e rede isolada: o FIAP Frames não consegue atrapalhar
> os vizinhos. O deploy chega por SSH, com uma chave que só executa o script de deploy.
>
> Na mensageria, cada fila tem três filas de retry com atraso crescente e uma DLQ. O contador de
> tentativas sempre avança, o que corrige o requeue infinito da fase anterior. E o upload grava
> o evento no banco na mesma transação do vídeo, o padrão outbox: nem com o RabbitMQ fora do ar
> um pedido se perde. Cada decisão importante tem um ADR, com as alternativas rejeitadas."

### 4. Demo: processamento, download e falha com e-mail (3:00-5:00)

**Tela:** <https://frames.asdevit.com> (já logado ou login com o usuário de teste), depois a
caixa de e-mail de teste.

1. Arrastar os três arquivos de `examples/` (`sample-ok-5s.mp4`, `sample-ok-10s.mp4`,
   `sample-corrupt.mp4`) e clicar em **Enviar 3 vídeos**.
2. Mostrar a tabela "Processamentos" mudando sozinha: Na fila → Processando → Concluído / Falhou.
3. **Baixar .zip** do vídeo de 10 s e abrir o zip (10 PNGs, `frame_0001.png` ...).
4. Mostrar a linha do corrompido: **Falhou**, código `P0001`.
5. Trocar para a caixa de e-mail: o aviso de falha. (Em produção só a falha gera e-mail,
   `NOTIFY_ON_SUCCESS=false`, que é o que o enunciado pede.)

> "Aqui está o sistema em produção. Envio três vídeos de uma vez: dois válidos e um corrompido.
> Cada arquivo vira um envio próprio, e a API responde 202 na hora: o vídeo foi guardado e
> entrou na fila, sem esperar o processamento. A tabela se atualiza sozinha: na fila,
> processando, concluído. O vídeo de 5 segundos gerou 5 frames, e o de 10, 10 frames. Clico em
> baixar: a API gera um link assinado que vale 5 minutos, e o zip tem os 10 PNGs, um por
> segundo. O arquivo corrompido passou na checagem do cabeçalho, mas o ffprobe recusou: o status
> é Falhou, com o código P0001 e uma mensagem clara. E aqui está o e-mail de aviso, enviado pelo
> Resend. Esse erro não gastou retries: erro no arquivo enviado vira resultado de negócio, não
> falha do sistema."

### 5. Demo: pico, fila e KEDA (5:00-6:30)

**Tela:** dividir em três: terminal da rajada (esquerda), `kubectl ... -w` (direita, em cima),
RabbitMQ **Queues** (direita, embaixo). Depois o Grafana, dashboard "FIAP Frames — Pipeline de
vídeos".

1. Rodar a rajada (comando pronto no checklist, passo 5): 5 uploads em paralelo de um vídeo
   Full HD de 60 s, pesado o bastante para um worker só não dar conta.
2. Todas as linhas `-> 202` aparecem em poucos segundos.
3. Rodar o 6º upload: `-> 429` com `V0007` e `Retry-After` (limite de 5 vídeos em andamento
   por usuário).
4. RabbitMQ: `worker.video-uploaded` com mensagens *Ready* subindo; *Unacked* = vídeos em
   processamento.
5. `kubectl`: o HPA do KEDA mostra a fila acima da meta e as réplicas passam de **1 para 2**;
   um pod novo do `video-worker` aparece.
6. Grafana: fila × workers, duração, DLQs em 0 e outbox pendente em 0.

> "Agora o pico. Disparo cinco uploads em paralelo de um vídeo Full HD de 60 segundos, e todos
> voltam 202 em poucos segundos. Um sexto recebe 429 com Retry-After: cada usuário tem no máximo
> cinco vídeos em andamento, para ninguém monopolizar a fila; o frontend espera e reenvia
> sozinho. No RabbitMQ, a fila do worker cresce: ela é o amortecedor do pico. O KEDA lê o tamanho
> dessa fila e sobe o worker de uma para duas réplicas; cada réplica processa um vídeo por vez.
> Na VM o teto é dois, para proteger os vizinhos; num cluster dedicado basta aumentar o máximo.
> No Grafana, o dashboard do pipeline mostra a fila, os workers e a duração; as DLQs continuam
> em zero e o outbox não tem nada pendente. No teste de carga com k6, foram 422 uploads em 20
> segundos: 100% aceitos, 100% concluídos, nenhum perdido."

### 6. Observabilidade (6:30-7:15)

**Tela:** Grafana → Explore → Loki com `{namespace="fiapx"} | correlationId="pico-3"`; depois o
dashboard "FIAP Frames — SLOs".

> "Todo pedido carrega um correlation id. Filtrando por ele no Loki, vejo o caminho inteiro: a
> requisição no video-api, o evento saindo pelo outbox, o worker processando e a notificação,
> sem nenhum dado pessoal nos logs. E este painel acompanha os SLOs: disponibilidade, tempo de
> aceite do upload, tempo de processamento, tempo até o resultado, que inclui a espera na fila,
> e sucesso do pipeline, com orçamento de erro, além de alertas para DLQ, outbox e fila sem
> consumidor."

### 7. Qualidade e CI/CD (7:15-8:30)

**Tela:** GitHub → Actions → última execução do CI na `main` (grafo dos jobs verdes) → log do
job `deploy` (linha do smoke com a versão `sha-...`) → `tests/bdd/features/02-falha.feature` →
(opcional) tabela de cobertura de um `npm run test:cov` gravado antes.

> "Cada push passa por este pipeline: lint e tipos; testes unitários com cobertura mínima de 80%
> em cada um dos oito projetos; testes de integração com RabbitMQ, Postgres, Garage e ffmpeg
> reais, entre eles a regressão do requeue infinito; E2E da API; validação dos manifestos do
> Kubernetes e busca de segredos no histórico. As imagens são construídas uma vez, e o BDD, com
> cenários escritos em português, roda o sistema completo com essas mesmas imagens. Só com tudo
> verde elas vão para o registry, e o deploy entra na VM por SSH, aplica as imagens fixadas por
> digest, roda as migrações e confere a versão pelo health check público. Se algo falha, a
> release anterior volta sozinha, e existe um botão de rollback manual."

### 8. Segurança e LGPD (8:30-9:00)

**Tela:** frontend → **Meus dados** → **Baixar meus dados (JSON)**; depois o terminal com o
`DELETE /api/me` (passo 6 do checklist): `204`, e o token antigo recebendo `A0003` (401).

> "Por fim, a LGPD. O cadastro exige o aceite da política, o vídeo original é apagado quando o
> processamento termina, o zip fica sete dias e as notificações são anonimizadas. O usuário
> baixa os próprios dados em JSON e pode excluir a conta: tudo é apagado numa transação e o
> token antigo deixa de valer na hora."

### 9. Encerramento (9:00-9:20)

**Tela:** `docs/arquitetura.md`, seção 12 (matriz de requisitos); por último o README com os
links.

> "Esta matriz liga cada requisito do enunciado à solução, ao código e a como demonstrar. Está
> tudo no GitHub, com o script de criação do banco em infra/db, e o sistema segue no ar em
> frames.asdevit.com. Obrigado!"

---

## Checklist antes de gravar

### Na véspera

- [ ] O último push na `main` está com o CI e o deploy verdes (aba Actions), e a produção já roda
  a versão com os limites por usuário (`V0007`), `NOTIFY_ON_SUCCESS=false` e os usuários do
  RabbitMQ por serviço: confira que `/api/health/live` mostra o `sha-<7>` desse commit. Esse
  deploy tem passos manuais na VM antes e depois (reinstalar o `deploy.sh` com
  `infra/vm/40-deployer-access.sh --yes` e as duas fases de segredos do
  [`infra/k8s/README.md`](../../infra/k8s/README.md), seção 8.1). Sem eles, o bloco 5 não mostra
  o `429 V0007` e o e-mail de sucesso ainda sai.
- [ ] Criar uma **caixa de e-mail de teste** só para a demo (nunca o e-mail pessoal) e conferir
  que os e-mails do FIAP Frames chegam nela (e não no spam).
- [ ] Ensaiar o roteiro uma vez inteira com cronômetro; cortar fala, não demo.
- [ ] Gravar os blocos 5 e 7 também como **plano B** (clipes curtos), caso algo falhe ao vivo.

### 30 minutos antes

**1. Variáveis da sessão** (terminal fora da gravação; nada disto aparece no vídeo):

```bash
export API=https://frames.asdevit.com
export VM_SSH=<alias do ~/.ssh/config>        # o alias, nunca o IP
export DEMO_EMAIL=<caixa de teste da demo>
read -rs DEMO_PASSWORD && export DEMO_PASSWORD  # digita a senha sem eco
cd <raiz do repositório>
```

**2. Produção saudável e em estado limpo:**

```bash
curl -fsS "$API/api/health/live" | jq                                   # "version": "sha-..." do último deploy
curl -fsS -o /dev/null -w '%{http_code}\n' "$API/api/health/ready"      # 200
ssh "$VM_SSH" 'k3s kubectl -n fiapx get pods'                            # tudo Running
ssh "$VM_SSH" 'k3s kubectl -n fiapx get scaledobject video-worker'       # READY True
ssh "$VM_SSH" 'k3s kubectl -n fiapx get hpa'                             # video-worker com 1 réplica antes do pico
```

Se o worker ainda estiver com 2 réplicas (teste anterior), espere o scale-down (estabilização
de 120 s, uma réplica por minuto).

**3. Túneis para o RabbitMQ e o Grafana** (cada um num terminal próprio, fora da gravação; o
port-forward escuta só no `127.0.0.1` da VM e o `ssh -L` o traz para o seu computador):

```bash
ssh -t -L 15672:127.0.0.1:15672 "$VM_SSH" 'k3s kubectl -n fiapx port-forward svc/rabbitmq 15672:15672'
ssh -t -L 3000:127.0.0.1:3000   "$VM_SSH" 'k3s kubectl -n fiapx port-forward svc/grafana 3000:3000'
# opcional: alertas e alvos no Prometheus
ssh -t -L 9090:127.0.0.1:9090   "$VM_SSH" 'k3s kubectl -n fiapx port-forward svc/prometheus 9090:9090'
```

Senhas: **copie direto para a área de transferência** (não imprima na tela) e cole no login:

```bash
# Grafana: usuário admin
ssh "$VM_SSH" "k3s kubectl -n fiapx get secret fiapx-grafana -o jsonpath='{.data.admin-password}' | base64 -d" | pbcopy
# RabbitMQ: usuário fiapx
ssh "$VM_SSH" "k3s kubectl -n fiapx get secret fiapx-rabbitmq -o jsonpath='{.data.RABBITMQ_DEFAULT_PASS}' | base64 -d" | pbcopy
```

No Grafana: abrir `http://localhost:3000/d/fiapx-pipeline` (intervalo "Last 15 minutes",
atualização a cada 5 s) e deixar o Explore do Loki em outra aba. No RabbitMQ:
`http://localhost:15672/#/queues` e conferir que as filas `*.dlq` estão em 0.

**4. Usuário de teste e token** (o cadastro também pode ser feito pelo frontend; o limite de
produção é de 10 cadastros por hora por IP):

```bash
curl -fsS -X POST "$API/api/auth/register" -H 'content-type: application/json' \
  -d "$(jq -n --arg n 'Pessoa Demo' --arg e "$DEMO_EMAIL" --arg p "$DEMO_PASSWORD" \
        '{name: $n, email: $e, password: $p, acceptPrivacyPolicy: true}')" | jq '{id, name}'
TOKEN=$(curl -fsS -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d "$(jq -n --arg e "$DEMO_EMAIL" --arg p "$DEMO_PASSWORD" '{email: $e, password: $p}')" | jq -r .accessToken)
```

O token vale 1 hora: gere-o perto da gravação. Entre no frontend com o mesmo usuário numa aba
já aberta.

**5. Vídeo e comandos da rajada do bloco 5** (o vídeo Full HD de 60 s leva vários segundos de
ffmpeg por upload num worker de 1 vCPU, tempo suficiente para a fila crescer e o KEDA reagir;
não vai para o Git). Antes de gravar, confira que o usuário de teste não tem vídeo em andamento
(os do bloco 4 já terminaram):

```bash
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=duration=60:size=1920x1080:rate=25 \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart /tmp/pico-60s.mp4

# a rajada: 5 uploads em paralelo (deixe digitado no terminal da gravação, sem executar)
seq 1 5 | xargs -P 5 -I{} curl -s -o /dev/null -w 'upload {} -> %{http_code}\n' \
  -X POST "$API/api/videos" -H "authorization: Bearer $TOKEN" \
  -H 'x-correlation-id: pico-{}' -F 'video=@/tmp/pico-60s.mp4'

# o 6º upload, logo depois: 429 V0007 com Retry-After (limite de vídeos em andamento)
curl -s -D - -o /tmp/sexto.json -X POST "$API/api/videos" -H "authorization: Bearer $TOKEN" \
  -F 'video=@/tmp/pico-60s.mp4' | grep -iE '^(HTTP|retry-after)'; jq '.error.code' /tmp/sexto.json
```

- Produção limita cada usuário a 5 vídeos em andamento (`MAX_PENDING_VIDEOS_PER_USER`) e a 30
  uploads por minuto: por isso a rajada tem 5 uploads. O excedente não se perde: recebe `429`
  com `Retry-After`, e o frontend espera e reenvia sozinho.
- Em produção só a falha gera e-mail e há um orçamento diário de e-mails (por usuário e total):
  não repita o vídeo corrompido do bloco 4 muitas vezes no mesmo dia.
- **Não rode o k6 contra produção**: ele cria um usuário por VU (esbarra no limite de cadastro)
  e dispara muitos uploads por usuário. O resultado do k6 no vídeo é o registrado em
  [`tests/load/README.md`](../../tests/load/README.md) (stack local).

Terminais do `kubectl` para o bloco 5 (deixe abertos antes de disparar a rajada):

```bash
ssh -t "$VM_SSH" 'k3s kubectl -n fiapx get hpa keda-hpa-video-worker -w'
ssh -t "$VM_SSH" 'k3s kubectl -n fiapx get pods -l app.kubernetes.io/name=video-worker -w'
```

**6. Comandos do bloco 8** (eliminação da conta; deixe por último, porque apaga o usuário, os
vídeos e as notificações dele):

```bash
curl -s -o /dev/null -w 'DELETE /api/me -> %{http_code}\n' -X DELETE "$API/api/me" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "$(jq -n --arg p "$DEMO_PASSWORD" '{password: $p}')"                  # 204
curl -s "$API/api/auth/me" -H "authorization: Bearer $TOKEN" | jq '.error.code'   # "A0003" (401)
```

Para gravar de novo depois disso, repita o passo 4 (cadastro e token).

**7. Abas abertas, nesta ordem:**

1. README: <https://github.com/arthurfcs98/fiap-fase5-fiapx>
2. Projeto base: `.../blob/main/legacy/projeto-base/main.go#L75-L124`
3. Arquitetura: `.../blob/main/docs/arquitetura.md`
4. ADRs: `.../tree/main/docs/adr`
5. Frontend: <https://frames.asdevit.com> (logado com o usuário de teste)
6. Caixa de e-mail de teste
7. RabbitMQ: `http://localhost:15672/#/queues`
8. Grafana: `http://localhost:3000/d/fiapx-pipeline` e o Explore (Loki)
9. Actions: `.../actions` (última execução verde na `main`, com o job `deploy`)
10. BDD: `.../blob/main/tests/bdd/features/02-falha.feature`

**8. Ambiente de gravação:** modo "Não perturbe" ligado; fonte do terminal grande; zoom do
navegador em 125%; barra de favoritos escondida; nenhuma aba com dado pessoal; histórico do
shell sem senha (use sempre as variáveis).

### Plano B (se a produção falhar durante a gravação)

O mesmo sistema sobe localmente em poucos minutos, com o Mailpit no lugar do e-mail real:

```bash
make up WORKERS=3      # stack completo com 3 workers
make demo-happy        # cadastro → upload → COMPLETED → download
make demo-sad          # vídeo corrompido → FAILED P0001 → e-mail no Mailpit (http://127.0.0.1:8025)
make load VUS=20 DURATION=20s   # pico com k6 (RabbitMQ local em http://127.0.0.1:15672)
```

Diga no vídeo que está usando o ambiente local e mostre os clipes gravados na véspera para a
parte de produção.

---

## Perguntas prováveis da banca (respostas curtas)

| Pergunta | Resposta | Onde aprofundar |
|---|---|---|
| Por que RabbitMQ e não Kafka? | O problema é fila de trabalho: ack por mensagem, retry com atraso e DLQ nativos, competing consumers com prefetch 1. Kafka é log particionado e seria pesado para a VM. | [ADR-0003](../adr/0003-rabbitmq-quorum-retry-dlq.md) |
| E se o RabbitMQ cair no meio de um pico? | O upload continua respondendo 202: o evento fica no outbox, na mesma transação do vídeo, e é publicado quando o broker voltar. | [ADR-0004](../adr/0004-outbox-e-consumidores-idempotentes.md) |
| E se o Postgres cair? | A API responde 503 com `Retry-After` (o frontend tenta de novo) e os consumidores devolvem a mensagem sem gastar retry e pausam até o banco voltar: nada vai para a DLQ. | `docs/arquitetura.md` §4.3 |
| E se o worker morrer processando um vídeo? | Não houve ack: o broker reentrega. O `x-delivery-limit` impede loop e, se esgotar, o vídeo vira `FAILED P0099` com e-mail (retries esgotados por falha transitória viram `P0098`). | `docs/arquitetura.md` §4.3 e §8.1 |
| Como evita processar duas vezes? | Consumidores idempotentes: inbox no `video-api`, zip com chave determinística no worker, `dedup_key` nas notificações. | ADR-0004 |
| Por que o worker é Node e não Go? | O trabalho pesado é o ffmpeg (processo nativo); o resto é orquestração que já existe nas libs compartilhadas. Uma toolchain só. | [ADR-0002](../adr/0002-typescript-nestjs-no-worker.md) |
| Por que K3s numa VM e não EKS? | Produção 24/7 sem custo, com Kubernetes de verdade; o EKS acabaria com o crédito de estudante em dias. Os vizinhos da VM são protegidos por quota, discos e rede isolados. | [ADR-0006](../adr/0006-k3s-na-vm-compartilhada.md) |
| Só 2 workers escala? | É o teto da VM compartilhada, não da arquitetura: num cluster dedicado basta subir o `maxReplicaCount`; no compose, `--scale video-worker=N`. | [ADR-0007](../adr/0007-autoescala-keda-e-hpa.md) |
| Onde está o script do banco? | `infra/db/`: criação de bancos e roles, migrações e o SQL legível equivalente, conferido com `pg_dump`. | [`infra/db/README.md`](../../infra/db/README.md) |
| Quais os limites conhecidos? | Nó único, sem backup automático, sem Alertmanager, upload até 95 MiB passando pela API. Estão listados com a evolução de cada um. | `docs/arquitetura.md` §14 |
