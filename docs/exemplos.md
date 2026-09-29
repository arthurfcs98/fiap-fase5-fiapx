# Exemplos de uso do FIAP Frames (passo a passo)

Tudo aqui roda na sua máquina, com o stack do `docker compose`. As respostas mostradas foram
**capturadas do stack rodando** (ids, datas e tokens mudam a cada execução; os comandos nunca
usam ids fixos: eles leem o id da resposta anterior com `jq`).

> Prefere clicar? O arquivo [`docs/exemplos.http`](exemplos.http) tem as mesmas requisições para
> a extensão **REST Client** do VS Code (sem Postman/Bruno).

## Sumário

1. [Subir o stack e os endereços locais](#1-subir-o-stack-e-os-endereços-locais)
2. [Vídeos de exemplo](#2-vídeos-de-exemplo)
3. [Roteiros prontos (1 comando)](#3-roteiros-prontos-1-comando)
4. [Passo a passo com curl](#4-passo-a-passo-com-curl) — saúde, cadastro, login, perfil,
   upload, listagem, detalhe, link de download, download, LGPD, Swagger, métricas
5. [Formato dos erros e códigos](#5-formato-dos-erros-e-códigos)
6. [Acompanhar a fila no RabbitMQ](#6-acompanhar-a-fila-no-rabbitmq)
7. [Ver os e-mails no Mailpit](#7-ver-os-e-mails-no-mailpit)
8. [Seguir um vídeo pelo correlation id](#8-seguir-um-vídeo-pelo-correlation-id)
9. [Usando o frontend (passo a passo em texto)](#9-usando-o-frontend-passo-a-passo-em-texto)
10. [Testes automatizados que cobrem estes exemplos](#10-testes-automatizados-que-cobrem-estes-exemplos)

---

## 1. Subir o stack e os endereços locais

Pré-requisitos: Docker (OrbStack ou Docker Desktop), `make`, `curl`, `jq` e, para gerar vídeos,
`ffmpeg`.

```bash
make up                # gera o .env com segredos locais e sobe tudo (espera ficar healthy)
make up WORKERS=3      # idem, com 3 réplicas do video-worker
make smoke             # confere health, métricas protegidas, buckets e ffmpeg só no worker
```

A ordem de subida é: infraestrutura (Postgres, Redis, RabbitMQ, Garage, Mailpit) → one-shots
(`garage-init` cria buckets e chave S3; `video-api-migrate` e `notification-migrate` aplicam as
migrações) → `video-api`, `video-worker` e `notification-service`.

| O quê | Endereço | Acesso |
|---|---|---|
| Frontend | <http://127.0.0.1:8080/> | cadastro pelo próprio site |
| API | <http://127.0.0.1:8080/api> | JWT (`Authorization: Bearer ...`) |
| Swagger | <http://127.0.0.1:8080/api/docs> | aberto |
| Política de privacidade | <http://127.0.0.1:8080/privacidade.html> | aberto |
| Mailpit (e-mails) | <http://127.0.0.1:8025> | aberto (só local) |
| RabbitMQ (filas) | <http://127.0.0.1:15672> | usuário `fiapx`, senha `RABBITMQ_PASSWORD` do `.env` |
| Métricas dos apps | `:9464/metrics` **dentro** de cada container | `Bearer METRICS_TOKEN` do `.env` |

Todas as portas são publicadas só em `127.0.0.1`. Os segredos ficam no `.env` (gerado por
`scripts/dev-secrets.sh`, ignorado pelo git).

## 2. Vídeos de exemplo

A pasta [`examples/`](../examples) tem três vídeos pequenos (versionados, < 100 KB cada),
gerados por `tests/fixtures/generate.sh --examples`:

| Arquivo | Conteúdo | Resultado esperado |
|---|---|---|
| `sample-ok-5s.mp4` | padrão de teste, 5 s, 320x240 | `COMPLETED`, zip com **5** PNGs |
| `sample-ok-10s.mp4` | padrão de teste, 10 s, 640x360 | `COMPLETED`, zip com **10** PNGs |
| `sample-corrupt.mp4` | cabeçalho MP4 válido + bytes aleatórios | aceito no upload (`202`), termina `FAILED` com `P0001` e dispara o e-mail de falha |

O `sample-corrupt.mp4` passa pela checagem de *magic bytes* da API (parece MP4), mas o `ffprobe`
do worker não consegue ler: é o jeito de demonstrar o caminho de falha até o e-mail.

Para regerar: `tests/fixtures/generate.sh --examples` (exemplos) ou `make fixtures` (os vídeos
dos testes, em `tests/fixtures/`, fora do git).

## 3. Roteiros prontos (1 comando)

```bash
make demo-happy     # scripts/demo/happy-path.sh [video]  (padrão: examples/sample-ok-10s.mp4)
make demo-sad       # scripts/demo/sad-path.sh [video]    (padrão: examples/sample-corrupt.mp4)
```

Saída real do `make demo-happy` (resumida):

```text
1. Cadastro (demo.1790639565.20028@example.com) — com aceite da política de privacidade
  POST /api/auth/register → 201 {"id":"ea1c8d6b-…","name":"Pessoa Demo","email":"demo.1790639565.20028@example.com"}
2. Login
  POST /api/auth/login → 200 (token JWT de 3600 s)
3. Upload de sample-ok-10s.mp4 (62386 bytes) — correlation id demo-1790639566-25292
  POST /api/videos → 202 {"id":"f5eab3ea-…","originalName":"sample-ok-10s.mp4","status":"QUEUED"}
4. Acompanhando o status (GET /api/videos/f5eab3ea-… a cada 1 s)
  t=1s status=QUEUED
  t=2s status=COMPLETED
  histórico: ["- → QUEUED: Upload recebido","QUEUED → PROCESSING: Processamento iniciado (tentativa 1)","PROCESSING → COMPLETED: Processamento concluído (10 frames)"]
5. Link de download assinado (HMAC, válido por 5 min)
6. Download do .zip (o link não precisa de token)
        23813  09-28-2026 23:52   frame_0001.png
        …
        23939  09-28-2026 23:52   frame_0010.png
       241835                     10 files
```

Saída real do `make demo-sad` (resumida):

```text
4. Acompanhando o status …
  t=1s status=QUEUED
  t=2s status=FAILED
  FAILED: P0001 — O arquivo não é um vídeo válido ou está corrompido.
5. Download recusado (não há zip)
  POST /api/videos/9b08b87b-…/download-url → 409 {"code":"V0004","message":"VIDEO_NOT_READY"}
6. E-mail de falha no Mailpit (http://127.0.0.1:8025)
  assunto: FIAP Frames: não foi possível processar o seu vídeo
  X-Correlation-Id: demo-1790639570-25622 (upload: demo-1790639570-25622)
```

## 4. Passo a passo com curl

Variáveis usadas em todos os comandos:

```bash
API=http://127.0.0.1:8080
EMAIL="maria.$(date +%s)@example.com"      # e-mail novo a cada execução
SENHA='senha-segura-123'
```

### 4.1 Saúde da API

```bash
curl -s $API/api/health/live
curl -s $API/api/health/ready
```

```json
{"status":"ok","service":"video-api","version":"dev"}
```

```json
{"status":"ok","info":{"database":{"status":"up"},"storage":{"status":"up"}},"error":{},"details":{"database":{"status":"up"},"storage":{"status":"up"}}}
```

`live` só diz que o processo responde; `ready` confere Postgres e os dois buckets do Garage (não
o RabbitMQ: com o broker fora, o upload continua funcionando pelo outbox).

### 4.2 Cadastro (`POST /api/auth/register`)

O aceite da política de privacidade é **obrigatório** (LGPD, base legal e transparência).

```bash
# sem aceite → 400 X0001
curl -s -X POST $API/api/auth/register -H 'content-type: application/json' \
  -d "{\"name\":\"Maria Silva\",\"email\":\"$EMAIL\",\"password\":\"$SENHA\"}"
```

```json
{
  "statusCode": 400,
  "error": {
    "message": "VALIDATION",
    "code": "X0001",
    "description": "Dados inválidos.",
    "metadata": {
      "fields": [
        {
          "field": "acceptPrivacyPolicy",
          "message": "É preciso aceitar a política de privacidade (acceptPrivacyPolicy: true)."
        }
      ]
    }
  },
  "timestamp": "2026-09-28T23:53:06.674Z",
  "path": "/api/auth/register",
  "correlationId": "974bf42d-1617-4951-b545-fe7c43b04261"
}
```

```bash
# com aceite → 201
curl -s -X POST $API/api/auth/register -H 'content-type: application/json' \
  -d "{\"name\":\"Maria Silva\",\"email\":\"$EMAIL\",\"password\":\"$SENHA\",\"acceptPrivacyPolicy\":true}"
```

```json
{"id":"558fbe56-7244-44a8-ab9b-468dc4e884c1","name":"Maria Silva","email":"maria.1790639586@example.com"}
```

A API grava a data do aceite e a versão da política (`2026-09-28`); veja em `GET /api/me/data`.

| Caso | Resposta real |
|---|---|
| mesmo e-mail de novo | `409` `{"error":{"message":"EMAIL_ALREADY_REGISTERED","code":"A0002","description":"Este e-mail já está cadastrado."}}` |
| senha com menos de 8 caracteres | `400` `X0001` com `{"field":"password","message":"A senha precisa ter pelo menos 8 caracteres."}` |
| mais de 10 cadastros por hora do mesmo IP (produção) | `429` `X0429` + `Retry-After` |

### 4.3 Login (`POST /api/auth/login`)

```bash
TOKEN=$(curl -s -X POST $API/api/auth/login -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$SENHA\"}" | jq -r .accessToken)
echo "$TOKEN"
```

Resposta completa:

```json
{"accessToken":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1NThm…","tokenType":"Bearer","expiresIn":3600}
```

O token é um JWT HS256 válido por 1 h (`iss=fiapx`, `aud=fiapx-web`, `sub` = id do usuário).

| Caso | Resposta real |
|---|---|
| senha errada | `401` `{"error":{"message":"INVALID_CREDENTIALS","code":"A0001","description":"E-mail ou senha inválidos."}}` |
| 6ª tentativa em 1 minuto (mesmo IP + e-mail) | `429` `{"error":{"message":"TOO_MANY_REQUESTS","code":"X0429","description":"Muitas requisições. Aguarde alguns instantes e tente de novo."}}` com `Retry-After: 60` |

Cabeçalhos das tentativas (capturados): `X-RateLimit-Limit: 5`, `X-RateLimit-Remaining: 4 … 0`
e, na sexta, `HTTP/1.1 429 Too Many Requests` + `Retry-After: 60`.

### 4.4 Perfil (`GET /api/auth/me`)

```bash
curl -s $API/api/auth/me -H "authorization: Bearer $TOKEN"
```

```json
{"id":"558fbe56-7244-44a8-ab9b-468dc4e884c1","name":"Maria Silva","email":"maria.1790639586@example.com"}
```

Sem token (ou token inválido/expirado, ou de um usuário já excluído) → `401`:

```json
{"statusCode":401,"error":{"message":"UNAUTHORIZED","code":"A0003","description":"Autenticação necessária ou token inválido.","metadata":{}},"timestamp":"2026-09-28T23:53:07.503Z","path":"/api/auth/me","correlationId":"cce77800-0c26-4da1-a6fb-d7b1f029551d"}
```

### 4.5 Upload (`POST /api/videos`)

Um arquivo por requisição, no campo multipart `video`. O upload vai em streaming direto para o
storage; a API responde `202` assim que o vídeo está salvo e o evento está no outbox (o
processamento acontece depois, no worker).

```bash
VIDEO_ID=$(curl -s -X POST $API/api/videos \
  -H "authorization: Bearer $TOKEN" \
  -H 'Idempotency-Key: ferias-2026-parte-1' \
  -H 'x-correlation-id: exemplo-upload-1' \
  -F 'video=@examples/sample-ok-10s.mp4' | tee /dev/stderr | jq -r .id)
```

```json
{"id":"e3bac2b2-4a8d-402f-b675-7e7a3d6d2db9","originalName":"sample-ok-10s.mp4","status":"QUEUED"}
```

Cabeçalhos relevantes da resposta (capturados):

```text
HTTP/1.1 202 Accepted
x-correlation-id: exemplo-upload-1
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 599
Content-Type: application/json; charset=utf-8
```

- **`Idempotency-Key`** (opcional): repetir a mesma requisição com a mesma chave devolve o
  **mesmo** vídeo (mesmo `id`), sem criar outro — útil quando a rede cai no meio do envio:

  ```json
  {"id":"e3bac2b2-4a8d-402f-b675-7e7a3d6d2db9","originalName":"sample-ok-10s.mp4","status":"QUEUED"}
  ```

- **`x-correlation-id`** (opcional, `[A-Za-z0-9._:-]{1,100}`): volta no cabeçalho da resposta e
  acompanha o vídeo pela fila, pelo worker e até o e-mail (seção 8). Sem ele, a API gera um UUID.
- Limite por usuário: 30 uploads/min em produção (o compose local usa 600/min para o k6).

| Caso | Resposta real |
|---|---|
| arquivo `.txt` (ou um "`.mp4`" que não é vídeo) | `400` `{"error":{"message":"UNSUPPORTED_FORMAT","code":"V0002","description":"Formato de vídeo não suportado.","metadata":{"allowed":[".mp4",".avi",".mov",".mkv",".wmv",".flv",".webm"]}}}` |
| arquivo com 96 MiB | `413` `{"error":{"message":"FILE_TOO_LARGE","code":"V0003","description":"O arquivo excede o limite de 95 MB.","metadata":{"maxMb":95}}}` |
| `examples/sample-corrupt.mp4` | `202` `QUEUED` (parece MP4) → depois `FAILED` `P0001` |
| sem token | `401` `A0003` |

A extensão **e** os *magic bytes* do arquivo são conferidos: renomear um texto para `.mp4` não
passa.

### 4.6 Listagem (`GET /api/videos`)

Só os vídeos do usuário do token, do mais novo para o mais antigo. Parâmetros: `page` (1…),
`limit` (padrão 20) e `status` (`QUEUED`, `PROCESSING`, `COMPLETED`, `FAILED`).

```bash
curl -s "$API/api/videos?page=1&limit=20" -H "authorization: Bearer $TOKEN" | jq
curl -s "$API/api/videos?status=FAILED" -H "authorization: Bearer $TOKEN" | jq
```

```json
{
  "items": [
    {
      "id": "5448c935-56ea-49ee-918f-a7bf32f55553",
      "originalName": "sample-corrupt.mp4",
      "sizeBytes": 65568,
      "contentType": "video/mp4",
      "status": "FAILED",
      "attempts": 1,
      "frameCount": null,
      "zipSizeBytes": null,
      "errorCode": "P0001",
      "errorMessage": "O arquivo não é um vídeo válido ou está corrompido.",
      "createdAt": "2026-09-28T23:53:07.576Z",
      "updatedAt": "2026-09-28T23:53:07.846Z",
      "startedAt": "2026-09-28T23:53:07.822Z",
      "completedAt": "2026-09-28T23:53:07.846Z",
      "expiredAt": null,
      "downloadAvailable": false
    },
    {
      "id": "e3bac2b2-4a8d-402f-b675-7e7a3d6d2db9",
      "originalName": "sample-ok-10s.mp4",
      "sizeBytes": 62386,
      "contentType": "video/mp4",
      "status": "COMPLETED",
      "attempts": 1,
      "frameCount": 10,
      "zipSizeBytes": 243057,
      "errorCode": null,
      "errorMessage": null,
      "createdAt": "2026-09-28T23:53:07.518Z",
      "updatedAt": "2026-09-28T23:53:07.814Z",
      "startedAt": "2026-09-28T23:53:07.705Z",
      "completedAt": "2026-09-28T23:53:07.814Z",
      "expiredAt": null,
      "downloadAvailable": true
    }
  ],
  "total": 2,
  "page": 1,
  "limit": 20
}
```

Para esperar o fim do processamento num script:

```bash
until curl -s "$API/api/videos/$VIDEO_ID" -H "authorization: Bearer $TOKEN" \
  | jq -e '.status == "COMPLETED" or .status == "FAILED"' > /dev/null; do sleep 1; done
```

### 4.7 Detalhe com histórico (`GET /api/videos/:id`)

```bash
curl -s $API/api/videos/$VIDEO_ID -H "authorization: Bearer $TOKEN" | jq
```

```json
{
  "id": "e3bac2b2-4a8d-402f-b675-7e7a3d6d2db9",
  "originalName": "sample-ok-10s.mp4",
  "sizeBytes": 62386,
  "contentType": "video/mp4",
  "status": "COMPLETED",
  "attempts": 1,
  "frameCount": 10,
  "zipSizeBytes": 243057,
  "errorCode": null,
  "errorMessage": null,
  "createdAt": "2026-09-28T23:53:07.518Z",
  "updatedAt": "2026-09-28T23:53:07.814Z",
  "startedAt": "2026-09-28T23:53:07.705Z",
  "completedAt": "2026-09-28T23:53:07.814Z",
  "expiredAt": null,
  "downloadAvailable": true,
  "history": [
    { "fromStatus": null, "toStatus": "QUEUED", "reason": "Upload recebido", "createdAt": "2026-09-28T23:53:07.518Z" },
    { "fromStatus": "QUEUED", "toStatus": "PROCESSING", "reason": "Processamento iniciado (tentativa 1)", "createdAt": "2026-09-28T23:53:07.705Z" },
    { "fromStatus": "PROCESSING", "toStatus": "COMPLETED", "reason": "Processamento concluído (10 frames)", "createdAt": "2026-09-28T23:53:07.814Z" }
  ]
}
```

O vídeo corrompido termina assim (trecho):

```json
{
  "status": "FAILED",
  "errorCode": "P0001",
  "errorMessage": "O arquivo não é um vídeo válido ou está corrompido.",
  "downloadAvailable": false,
  "history": [
    { "fromStatus": null, "toStatus": "QUEUED", "reason": "Upload recebido" },
    { "fromStatus": "QUEUED", "toStatus": "PROCESSING", "reason": "Processamento iniciado (tentativa 1)" },
    { "fromStatus": "PROCESSING", "toStatus": "FAILED", "reason": "Falha no processamento (P0001)" }
  ]
}
```

Vídeo que não existe **ou é de outro usuário** → `404` (a API nem revela que o vídeo existe):

```json
{"statusCode":404,"error":{"message":"VIDEO_NOT_FOUND","code":"V0001","description":"Vídeo não encontrado.","metadata":{"id":"00000000-0000-4000-8000-000000000000"}},"timestamp":"2026-09-28T23:54:53.553Z","path":"/api/videos/00000000-0000-4000-8000-000000000000","correlationId":"d904c5ef-351c-49a9-a337-fff282f2db40"}
```

### 4.8 Link de download (`POST /api/videos/:id/download-url`)

```bash
URL=$(curl -s -X POST $API/api/videos/$VIDEO_ID/download-url \
  -H "authorization: Bearer $TOKEN" | tee /dev/stderr | jq -r .url)
```

```json
{"url":"http://localhost:8080/api/downloads/e3bac2b2-4a8d-402f-b675-7e7a3d6d2db9?exp=1790639993&sig=_Ghcfk_9VUHJuaRnq1bAbXZ2Y4Elwwr6ioLIZV0_9mc","expiresAt":"2026-09-28T23:59:53.000Z"}
```

O link é assinado com HMAC e vale **5 minutos**; quem tem o link baixa sem token (por isso ele
nunca aparece nos logs).

| Caso | Resposta real |
|---|---|
| vídeo `FAILED` (ou ainda na fila) | `409` `{"error":{"message":"VIDEO_NOT_READY","code":"V0004","description":"O vídeo ainda não terminou de processar.","metadata":{"id":"5448c935-…","status":"FAILED"}}}` |
| zip já apagado pela retenção (LGPD) | `410` `{"error":{"message":"ZIP_EXPIRED","code":"V0006","description":"O arquivo .zip deste vídeo expirou e foi removido pela política de retenção."}}` |
| vídeo de outro usuário | `404` `V0001` |

### 4.9 Download do zip (`GET /api/downloads/:id?exp=&sig=`)

```bash
curl -s -D - -o frames.zip "$URL" | grep -iE '^HTTP|content-'
unzip -l frames.zip
```

```text
HTTP/1.1 200 OK
Content-Type: application/zip
Content-Disposition: attachment; filename="sample-ok-10s_frames.zip"; filename*=UTF-8''sample-ok-10s_frames.zip
Content-Length: 243057

    23813  09-28-2026 23:53   frame_0001.png
    …
    23939  09-28-2026 23:53   frame_0010.png
   241835                     10 files
```

Assinatura alterada ou link vencido → `403`:

```json
{"statusCode":403,"error":{"message":"INVALID_DOWNLOAD_SIGNATURE","code":"V0005","description":"Link de download inválido ou expirado.","metadata":{}},"timestamp":"2026-09-28T23:54:53.622Z","path":"/api/downloads/e3bac2b2-4a8d-402f-b675-7e7a3d6d2db9?exp=1790639993&sig=assinatura-invalida","correlationId":"e9b59083-c38c-495e-a818-721cd4819ecc"}
```

Depois do prazo de retenção (`ZIP_RETENTION_DAYS`, padrão 7 dias), o mesmo link responde `410`
`V0006`. Para ver isso em segundos: `make bdd-up` sobe o stack com retenção de ~43 s (depois
volte com `make up`).

### 4.10 Direitos do titular (LGPD)

**Exportar os meus dados** (`GET /api/me/data`, art. 18 II e V): usuário (sem o hash da senha),
todos os vídeos e o histórico de cada um.

```bash
curl -s $API/api/me/data -H "authorization: Bearer $TOKEN" | jq
```

```json
{
  "exportedAt": "2026-09-28T23:54:53.634Z",
  "user": {
    "id": "558fbe56-7244-44a8-ab9b-468dc4e884c1",
    "name": "Maria Silva",
    "email": "maria.1790639586@example.com",
    "createdAt": "2026-09-28T23:53:06.686Z",
    "updatedAt": "2026-09-28T23:53:06.686Z",
    "privacyAcceptedAt": "2026-09-28T23:53:06.686Z",
    "privacyPolicyVersion": "2026-09-28"
  },
  "videos": [
    {
      "id": "e3bac2b2-4a8d-402f-b675-7e7a3d6d2db9",
      "originalName": "sample-ok-10s.mp4",
      "status": "COMPLETED",
      "frameCount": 10,
      "history": [
        { "fromStatus": null, "toStatus": "QUEUED", "reason": "Upload recebido" },
        { "fromStatus": "QUEUED", "toStatus": "PROCESSING", "reason": "Processamento iniciado (tentativa 1)" },
        { "fromStatus": "PROCESSING", "toStatus": "COMPLETED", "reason": "Processamento concluído (10 frames)" }
      ]
    }
  ]
}
```

(trecho: a resposta real traz todos os campos do vídeo, como na listagem, e todos os vídeos.)

**Excluir a minha conta** (`DELETE /api/me`, art. 18 VI): pede a senha de novo.

```bash
# senha errada → 400 A0004 (a conta continua ativa)
curl -s -X DELETE $API/api/me -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"password":"errada"}'
```

```json
{"statusCode":400,"error":{"message":"INVALID_PASSWORD_CONFIRMATION","code":"A0004","description":"Senha de confirmação incorreta.","metadata":{}},"timestamp":"2026-09-28T23:54:53.889Z","path":"/api/me","correlationId":"0b89e34f-6d27-4432-a42a-1cae35385786"}
```

```bash
# senha certa → 204 (sem corpo)
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE $API/api/me \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"password\":\"$SENHA\"}"
# 204

# o token antigo deixa de valer na hora
curl -s -o /dev/null -w '%{http_code}\n' $API/api/auth/me -H "authorization: Bearer $TOKEN"
# 401
```

O que a exclusão faz: numa transação apaga histórico, vídeos e usuário e grava o evento
`user.deleted` no outbox; depois apaga todos os objetos `{userId}/…` dos buckets `fiapx-raw` e
`fiapx-zips`. O `notification-service` recebe o `user.deleted` e anonimiza as notificações
daquele usuário (`recipient = 'removido'`, `payload = '{}'`). Para conferir no banco local:

```bash
docker compose exec postgres psql -U fiapx -d fiapx_notification \
  -c "select type, recipient, status, payload from notifications order by created_at desc limit 5"
```

```text
      type       | recipient | status | payload
-----------------+-----------+--------+---------
 VIDEO_FAILED    | removido  | SENT   | {}
 VIDEO_COMPLETED | removido  | SENT   | {}
```

Mais detalhes (mapa de dados, bases legais, retenção): [`docs/lgpd.md`](lgpd.md).

### 4.11 Swagger

<http://127.0.0.1:8080/api/docs> (UI) e `GET /api/docs-json` (OpenAPI). Rotas documentadas:

```json
["/api/auth/login","/api/auth/me","/api/auth/register","/api/downloads/{id}","/api/health/live",
 "/api/health/ready","/api/me","/api/me/data","/api/videos","/api/videos/{id}",
 "/api/videos/{id}/download-url"]
```

No Swagger, clique em **Authorize** e cole só o token (sem `Bearer`).

### 4.12 Métricas (Prometheus)

A porta `9464` é interna (não é publicada). Para ver de dentro do container, com o token do
próprio container:

```bash
docker compose exec video-api sh -c \
  'wget -qO- --header "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:9464/metrics' \
  | grep -E '^fiapx_(videos|outbox|http_request_duration_seconds_count)'
```

```text
fiapx_videos_uploaded_total{service="video-api"} 4
fiapx_videos_completed_total{service="video-api"} 3
fiapx_videos_failed_total{error_code="P0001",service="video-api"} 1
fiapx_outbox_pending{service="video-api"} 0
fiapx_http_request_duration_seconds_count{service="video-api",method="POST",route="/api/videos",status="202"} 4
fiapx_http_request_duration_seconds_count{service="video-api",method="GET",route="/api/downloads/:id",status="200"} 1
```

```bash
docker compose exec video-worker sh -c \
  'wget -qO- --header "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:9464/metrics' \
  | grep -E '^fiapx_worker_jobs_total'
```

```text
fiapx_worker_jobs_total{result="completed",service="video-worker"} 3
fiapx_worker_jobs_total{result="failed",service="video-worker"} 1
```

Sem o token, `/metrics` responde `401`. No Kubernetes o Prometheus coleta estas métricas e o
Grafana mostra os dashboards (`docs/observabilidade.md`).

## 5. Formato dos erros e códigos

Todo erro tem o mesmo formato (o `correlationId` é o mesmo do cabeçalho `x-correlation-id`):

```json
{
  "statusCode": 404,
  "error": { "message": "VIDEO_NOT_FOUND", "code": "V0001", "description": "Vídeo não encontrado.", "metadata": { "id": "…" } },
  "timestamp": "2026-09-28T23:54:53.553Z",
  "path": "/api/videos/…",
  "correlationId": "d904c5ef-351c-49a9-a337-fff282f2db40"
}
```

| Código | HTTP | Quando |
|---|---|---|
| `A0001` INVALID_CREDENTIALS | 401 | login com e-mail/senha errados |
| `A0002` EMAIL_ALREADY_REGISTERED | 409 | cadastro com e-mail existente |
| `A0003` UNAUTHORIZED | 401 | sem token, token inválido/expirado ou de usuário excluído |
| `A0004` INVALID_PASSWORD_CONFIRMATION | 400 | `DELETE /api/me` com a senha errada |
| `V0001` VIDEO_NOT_FOUND | 404 | vídeo inexistente ou de outro usuário |
| `V0002` UNSUPPORTED_FORMAT | 400 | extensão ou conteúdo que não é vídeo |
| `V0003` FILE_TOO_LARGE | 413 | acima de `MAX_UPLOAD_MB` (95) |
| `V0004` VIDEO_NOT_READY | 409 | link de download de vídeo não concluído |
| `V0005` INVALID_DOWNLOAD_SIGNATURE | 403 | link adulterado ou vencido |
| `V0006` ZIP_EXPIRED | 410 | zip removido pela retenção |
| `X0001` VALIDATION | 400 | corpo inválido (lista os campos em `metadata.fields`) |
| `X0429` TOO_MANY_REQUESTS | 429 | throttling (com `Retry-After`) |
| `P0001`…`P0099` | — | gravados em `errorCode` do vídeo `FAILED` (`P0001` vídeo inválido, `P0003` longo demais, `P0098` tentativas esgotadas, `P0099` dead-letter) |

Lista completa: `docs/arquitetura/contratos.md`, seção 4.

## 6. Acompanhar a fila no RabbitMQ

1. Abra <http://127.0.0.1:15672> e entre com `fiapx` / o valor de `RABBITMQ_PASSWORD` do `.env`
   (`grep RABBITMQ_PASSWORD .env`).
2. Aba **Exchanges** → `fiapx.events` (topic): todos os eventos passam por ela.
3. Aba **Queues**:
   - `worker.video-uploaded`: vídeos esperando um worker. Durante um pico (`make load`) a coluna
     *Ready* sobe e volta a zero conforme os workers consomem; *Unacked* = vídeos em processamento
     (1 por worker, prefetch 1).
   - `worker.video-uploaded.retry.1/.2/.3`: tentativas atrasadas (5 s, 30 s, 120 s) de falhas
     transitórias.
   - `*.dlq`: mensagens que esgotaram as tentativas (devem ficar em 0; o `video-api` marca o vídeo
     como `FAILED P0099`).
   - `api.video-processing` (eventos do worker para a API) e `notification.events` (para o
     serviço de e-mail).
4. Clique numa fila → **Get messages** para ver o envelope (`id`, `type`, `correlationId`,
   `payload`) sem consumir de vez (use *Nack message requeue true*).

Para ver a fila encher de verdade, pare os workers, envie vídeos e religue:

```bash
docker compose stop video-worker
for i in 1 2 3 4 5; do curl -s -o /dev/null -X POST $API/api/videos -H "authorization: Bearer $TOKEN" -F 'video=@examples/sample-ok-5s.mp4'; done
# RabbitMQ UI: worker.video-uploaded com 5 mensagens Ready; os vídeos ficam QUEUED
docker compose up -d --scale video-worker=3 video-worker
# a fila esvazia e os 5 vídeos terminam COMPLETED
```

## 7. Ver os e-mails no Mailpit

O compose local usa o Mailpit no lugar do Resend (`EMAIL_PROVIDER=smtp`): nenhum e-mail sai da
sua máquina.

1. Abra <http://127.0.0.1:8025>.
2. Cada vídeo `FAILED` gera o e-mail **"FIAP Frames: não foi possível processar o seu vídeo"**
   (com o código `P00xx` e o link para o site). No compose, `NOTIFY_ON_SUCCESS=true`, então cada
   `COMPLETED` gera também **"FIAP Frames: o seu vídeo foi processado"**.
3. Aba **Headers** do e-mail: `X-Correlation-Id` é o mesmo id do upload.

Pela API do Mailpit:

```bash
curl -s "http://127.0.0.1:8025/api/v1/search?query=to:\"$EMAIL\"" \
  | jq '.messages[] | {Subject, To: [.To[].Address]}'
```

```json
{"Subject":"FIAP Frames: não foi possível processar o seu vídeo","To":["maria.1790639586@example.com"]}
{"Subject":"FIAP Frames: o seu vídeo foi processado","To":["maria.1790639586@example.com"]}
```

## 8. Seguir um vídeo pelo correlation id

O id enviado no upload (`x-correlation-id`) atravessa HTTP → outbox → RabbitMQ → worker →
notification-service → cabeçalho do e-mail:

```bash
docker compose logs --no-log-prefix video-api video-worker notification-service \
  | grep '"correlationId":"exemplo-upload-1"' | jq -c '{service, msg, videoId}'
```

Os logs são JSON (pino) e só têm ids (`userId`, `videoId`): e-mail, nome, nome do arquivo e o
link assinado nunca aparecem (LGPD; o BDD confere isso a cada execução). No Kubernetes a mesma
busca é feita no Grafana → Explore → Loki: `{namespace="fiapx"} | json | correlationId="…"`.

## 9. Usando o frontend (passo a passo em texto)

Abra <http://127.0.0.1:8080/>. A página é estática (servida pelo próprio `video-api`) e navega
por âncoras (`#/entrar`, `#/cadastro`, `#/videos`, `#/meus-dados`).

1. **Criar conta** (aba "Criar conta"): nome, e-mail, senha (mín. 8 caracteres) e confirmação.
   Marque a caixa de aceite da **Política de Privacidade** (o link abre `/privacidade.html`) —
   sem ela o formulário não envia. Clique em **Criar conta**: a página já entra na conta e abre
   "Seus vídeos". (Se o login automático for barrado pelo limite de 5 tentativas por minuto, ela
   volta para "Entrar" com o e-mail preenchido e a mensagem "Conta criada! Entre com seu e-mail e
   senha.")
2. **Entrar** (aba "Entrar"): e-mail e senha → **Entrar**. O token fica só na aba
   (`sessionStorage`); fechar a aba ou o token expirar (1 h) encerra a sessão.
3. **Enviar vídeos** (tela "Seus vídeos", cartão "Enviar vídeos"): arraste um ou vários arquivos
   para a área "Arraste vídeos para cá" ou clique em "escolha no computador" e selecione, por
   exemplo, os três arquivos de `examples/`. Eles entram numa lista ("Pronto para enviar", com
   tamanho e botão **Remover**); clique em **Enviar 3 vídeos**. Cada arquivo vira um envio
   próprio (até 3 ao mesmo tempo), com barra de progresso, e termina em "Recebido. Na fila de
   processamento.". Arquivos com extensão errada ou acima de 95 MB são recusados antes de enviar.
   Se a API responder 429/503, o envio tenta de novo sozinho (respeitando o `Retry-After`); outros
   erros mostram a mensagem da API e o botão "Tentar de novo".
4. **Acompanhar** (cartão "Processamentos"): a tabela (Vídeo, Enviado, Status, Frames) se
   atualiza a cada 3 s — pausa quando a aba fica em segundo plano. Os status aparecem como
   *Na fila*, *Processando*, *Concluído* e *Falhou* (com a mensagem e o código `P00xx`). O filtro
   "Todos os status" e os botões **Anterior**/**Próxima** paginam a lista.
5. **Baixar**: nos vídeos *Concluído*, o botão **Baixar .zip** pede um link assinado ("Gerando
   link…") e o navegador baixa `<nome>_frames.zip`. Se o zip já passou da retenção, a linha vira
   *Expirado*.
6. **Ver o e-mail de falha**: envie `examples/sample-corrupt.mp4`, espere o *Falhou* e abra o
   Mailpit (<http://127.0.0.1:8025>).
7. **Meus dados** (menu superior): mostra nome, e-mail e identificador; **Baixar meus dados
   (JSON)** salva `fiap-frames-meus-dados-<data>.json`, o mesmo conteúdo de `GET /api/me/data`.
8. **Excluir minha conta**: abre um diálogo que pede a senha e a confirmação "Entendo que a
   exclusão é definitiva." → **Excluir definitivamente**. Senha errada mostra o erro `A0004` e
   mantém a sessão; senha certa apaga tudo e sai.
9. **Sair**: botão no canto superior.

Em erros 5xx a página mostra o "ID de suporte" (o `correlationId`) para procurar nos logs.

## 10. Testes automatizados que cobrem estes exemplos

| Comando | O que roda |
|---|---|
| `make test-bdd` | sobe o stack de BDD (3 workers, retenção curta) e roda os cenários em pt-BR de `tests/bdd/features` (processamento e download, falha com e-mail, isolamento/401, pico de 15 uploads, LGPD, retenção, observabilidade e logs sem dados pessoais) |
| `make load VUS=20 DURATION=30s` | k6: pico com 100% de `202` e 100% `COMPLETED` (`tests/load/README.md`) |
| `make demo-happy` / `make demo-sad` | os roteiros da seção 3 |
| `make smoke` | health, métricas protegidas, buckets, ffmpeg só no worker |
