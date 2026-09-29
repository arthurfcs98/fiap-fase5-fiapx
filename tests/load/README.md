# Teste de pico (k6)

`spike.js` simula um pico de envios: **N usuários virtuais** (VUs) enviam vídeos ao mesmo tempo
e o teste só passa se:

| Threshold | Significado |
|---|---|
| `uploads_accepted: rate==1` | 100% dos uploads responderam **202** (nenhum recusado ou perdido na borda) |
| `videos_completed: rate==1` | todo vídeo aceito terminou **COMPLETED** (nenhum perdido na fila) |
| `http_req_duration{name:upload}: p(95)<5000` | SLO de aceite do upload (contratos.md, seção 13) |
| `checks: rate==1` | cadastro, login e uploads sem erro |

Cada VU tem o próprio usuário (criado no `setup`). No fim (`teardown`), o script espera a fila
esvaziar (até `PROCESS_TIMEOUT_S`) e confere o status de todos os vídeos.

## Como rodar

Pré-requisitos: [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) instalado e o stack
no ar. O vídeo enviado é o `examples/sample-ok-5s.mp4` (versionado, 5 s, 25 KB).

```bash
make up WORKERS=3            # stack local com 3 workers
make load VUS=20 DURATION=30s
# ou direto:
k6 run -e BASE_URL=http://127.0.0.1:8080 -e VUS=20 -e DURATION=30s tests/load/spike.js
```

| Variável | Padrão | Uso |
|---|---|---|
| `BASE_URL` | `http://127.0.0.1:8080` | origem da API |
| `VUS` | `20` | usuários virtuais no pico |
| `DURATION` | `30s` | duração do platô (mais 5 s de subida e 5 s de descida) |
| `PAUSE_S` | `1` | pausa entre dois uploads do mesmo VU |
| `PROCESS_TIMEOUT_S` | `300` | espera máxima pela fila no `teardown` |

## Resultado de referência (Mac M-series, OrbStack, 3 workers)

```
=== FIAP Frames: teste de pico (k6) ===
uploads enviados ............ 422
uploads aceitos (202) ....... 100.00%
vídeos encontrados no fim ... 422 (perdidos: 0)
vídeos COMPLETED ............ 100.00%
p95 do upload ............... 1634 ms (SLO < 5000 ms)

thresholds:
  OK     http_req_duration{name:upload}: p(95)<5000
  OK     uploads_accepted: rate==1
  OK     checks: rate==1
  OK     videos_completed: rate==1
```

## O que observar durante o teste (bom para o vídeo)

- **RabbitMQ** (`http://127.0.0.1:15672`, usuário `fiapx`, senha `RABBITMQ_PASSWORD` do `.env`):
  aba *Queues*, fila `worker.video-uploaded` — as mensagens sobem no pico e são drenadas pelos
  workers; as filas `*.dlq` continuam em 0.
- **Workers**: `docker compose logs -f video-worker` mostra as 3 réplicas dividindo o trabalho.
- **Métricas**: `docker compose exec video-worker sh -c 'wget -qO- --header "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:9464/metrics' | grep fiapx_worker_jobs_total`.
- No Kubernetes, o KEDA escala o `video-worker` pela profundidade da fila e o dashboard
  "FIAP Frames — Pipeline de vídeos" do Grafana mostra fila, réplicas e duração
  (`docs/observabilidade.md`).

## Limites do stack local

O compose local afrouxa o limite de cadastro (1000/h por IP) e de upload (600/min por usuário)
para permitir o teste (`THROTTLE_REGISTER_LIMIT`, `THROTTLE_UPLOAD_LIMIT` no `compose.yaml`).
A produção usa os padrões do contrato (10 cadastros/h por IP, 30 uploads/min por usuário, login
5/min). Com os padrões, o k6 recebe `429 X0429` — o que também é um resultado válido para mostrar
o throttling funcionando.
