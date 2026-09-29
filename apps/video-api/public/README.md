# Frontend estático do FIAP Frames

HTML, CSS e JavaScript puros (módulos ES, sem build), em pt-BR, servidos pelo `video-api` em `/`
(contratos.md §8). Consome só a API do próprio `video-api`, na mesma origem.

## Telas

| Rota | O que faz |
|---|---|
| `#/entrar`, `#/cadastro` | Login e cadastro. O cadastro exige marcar "Li e aceito a Política de Privacidade" e envia `acceptPrivacyPolicy: true` (§12). |
| `#/videos` | Upload de vários vídeos de uma vez e tabela dos vídeos do usuário, atualizada a cada 3 s. |
| `#/meus-dados` | LGPD: dados da conta, **Baixar meus dados (JSON)** (`GET /api/me/data`) e **Excluir minha conta** (`DELETE /api/me` com a senha). |
| `/privacidade.html` | Política de Privacidade (versão `2026-09-28`, a mesma de `PRIVACY_POLICY_VERSION`). |

## Como funciona

- **Sessão:** o JWT fica no `sessionStorage` (só na aba). Um `401` em qualquer chamada autenticada, ou
  o `exp` do token, encerra a sessão com aviso. Sem cookies.
- **Upload:** um `POST /api/videos` por arquivo (campo `video`), até 3 em paralelo, cada um com
  barra de progresso (`XMLHttpRequest`), `Idempotency-Key` e `x-correlation-id` próprios. A chave
  se repete nas novas tentativas. Só `429` e `503` são repetidos sozinhos (respeitando `Retry-After`);
  os outros erros mostram o motivo e um botão "Tentar de novo" com a mesma chave. Extensão e
  tamanho (95 MB) são conferidos antes de enviar, mas quem decide é a API.
- **Lista:** `GET /api/videos` a cada 3 s, pausado com a aba em segundo plano. Status: Na fila,
  Processando, Concluído, Falhou (com a mensagem e o código `P00xx`) e **Expirado** (vídeo com
  `expiredAt` ou que recebeu `410 V0006` no download).
- **Download:** `POST /api/videos/:id/download-url` e em seguida o navegador segue a URL assinada.
  Só são aceitas URLs `/api/downloads/…`, sempre reancoradas na origem da página.
- **Erros:** vêm do envelope `{ statusCode, error: { message, code, description, metadata }, correlationId }`.
  A tela mostra a `description` com o código (ex.: `E-mail ou senha inválidos. (A0001)`) e, em 5xx,
  o `correlationId` como "ID de suporte".

## Segurança

- Compatível com CSP estrita (`default-src 'self'; script-src 'self'; style-src 'self'`): nenhum
  script, estilo ou atributo `style` inline, e nenhum recurso de terceiros (fontes em `fonts/`,
  licença SIL OFL ao lado).
- Todo dado vindo da API entra na página por `textContent`/`setAttribute`, nunca `innerHTML`.

## Arquivos

```
index.html  privacidade.html  favicon.svg
css/styles.css
js/app.js       entrada: rotas, sessão, arrastar e soltar
js/auth.js      login e cadastro
js/uploads.js   fila de upload
js/videos.js    tabela, polling, download
js/account.js   Meus dados (LGPD)
js/api.js       cliente HTTP e envelope de erro
js/session.js   sessionStorage
js/format.js    formatação e regras puras (sem DOM)
js/dom.js       utilitários de DOM
fonts/          Bricolage Grotesque e JetBrains Mono (woff2, subset latin)
```

## Rodando local

Com a stack de pé (`make up`), abrir `http://localhost:8080/` (`API_HOST_PORT`, padrão 8080).
Para mexer só no visual, qualquer servidor estático serve os arquivos, mas as chamadas `/api/*`
precisam do `video-api` na mesma origem.

Checagens: `npx eslint apps/video-api/public` e `npx prettier --check apps/video-api/public`.
