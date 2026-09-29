# ADR-0008: Usuário e senha com JWT e download por URL assinada

- Status: aceita
- Data: 2026-09-28

## Contexto

O enunciado exige que o sistema seja protegido por usuário e senha e que cada usuário veja os
próprios vídeos. O projeto base não tinha usuário e servia os zips publicamente pelo nome.

O download tem uma particularidade: o navegador baixa arquivos **navegando** até um link, e uma
navegação não carrega o header `Authorization`. Carregar o zip via `fetch` e montar um blob
colocaria o arquivo inteiro na memória do navegador.

## Decisão

- **Módulo `auth` no `video-api`**:
  - cadastro com nome, e-mail (`citext`, único), senha de 8 a 72 bytes guardada com **bcrypt
    custo 12** e aceite obrigatório da política de privacidade;
  - login devolve **JWT HS256 de 1 h** (`iss`, `aud` e só o `sub`);
  - **guard global**: toda rota exige token, exceto as marcadas com `@Public()`;
  - a estratégia JWT confere a cada requisição se o usuário ainda existe (conta excluída
    invalida os tokens na hora);
  - login com e-mail inexistente compara com um hash fictício (sem diferença de tempo que revele
    quais e-mails existem);
  - throttling em Redis: login 5/min por IP + e-mail e 30/min por IP (cada tentativa custa um
    bcrypt), cadastro 10/h por IP;
  - Postgres fora do ar ao validar o token responde `503 X0003`, nunca `401` (o usuário não é
    deslogado por uma falha do servidor).
- **Isolamento por dono**: toda consulta filtra por `user_id`; vídeo de outro usuário responde
  `404` (não revela que existe).
- **Download em dois passos**:
  1. `POST /api/videos/:id/download-url` (JWT + dono) devolve uma URL com `exp` e
     `sig = base64url(HMAC-SHA256(DOWNLOAD_URL_SECRET, "v1:<videoId>:<exp>"))`, válida por
     **5 minutos**;
  2. `GET /api/downloads/:id?exp=&sig=` (pública) confere a assinatura em tempo constante e faz
     stream do zip do bucket privado, com `Cache-Control: no-store` e
     `Referrer-Policy: no-referrer`. O log de acesso grava o caminho **sem a query string** (a
     assinatura nunca vai para o log).
- Segredos separados (`JWT_SECRET` e `DOWNLOAD_URL_SECRET`), só em Secrets do K8s.

## Consequências

**Positivas (+)**

- Atende o requisito com autenticação sem estado: qualquer réplica valida o token.
- Download por navegação simples, sem o zip na memória do navegador e sem expor o storage.
- Prefixo de versão (`v1:`) permite trocar o formato da assinatura sem aceitar links antigos.

**Negativas (−)**

- Sem refresh token: depois de 1 h o usuário entra de novo.
- HS256 usa segredo simétrico (adequado com um único emissor e verificador); trocar o segredo
  desloga todo mundo.
- O link assinado pode ser repassado durante os 5 minutos de validade.
- Sem confirmação de e-mail no cadastro (evolução registrada na arquitetura, seção 14).

## Alternativas rejeitadas

| Alternativa | Por que não |
|---|---|
| RS256 + JWKS ou um serviço de autenticação separado | um único emissor e um único verificador: complexidade sem ganho |
| Sessão no servidor com cookie | estado compartilhado entre réplicas e proteção contra CSRF |
| URL pré-assinada do S3 (ou redirecionar para ela) | exigiria publicar o storage num hostname próprio, com CORS no bucket |
| `fetch` + blob no navegador | o zip inteiro na memória do navegador |
| Login social / OAuth | fora do escopo pedido (usuário e senha) |

## Onde está

- `apps/video-api/src/modules/auth/` (use cases, `jwt.strategy.ts`, `jwt-auth.guard.ts`, `bcrypt-password-hasher.ts`)
- `apps/video-api/src/modules/videos/infrastructure/signing/hmac-download.signer.ts`
- `apps/video-api/src/modules/videos/application/use-cases/create-download-url.use-case.ts` e `open-download.use-case.ts`
- `apps/video-api/src/shared/infrastructure/throttling/`
- `tests/bdd/features/03-isolamento.feature` (404 para vídeo alheio, 401 sem token)
