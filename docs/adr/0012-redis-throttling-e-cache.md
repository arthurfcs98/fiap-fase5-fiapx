# ADR-0012: Redis para throttling e cache de Idempotency-Key

- Status: aceita
- Data: 2026-09-28

## Contexto

O enunciado recomenda "PostgreSQL + Redis (cache)". Dois problemas pedem um armazenamento rápido
e compartilhado entre as réplicas do `video-api`:

- **limite de tentativas** (login, cadastro, upload, exclusão de conta): com contadores em
  memória, cada réplica teria o próprio limite e ele se multiplicaria com a escala;
- **idempotência do upload**: o header `Idempotency-Key` é consultado antes de ler o corpo do
  upload, num caminho quente.

Cache de dado que muda (ex.: a listagem de status) mostraria status velho justamente na tela
que o usuário acompanha.

## Decisão

- **Redis 7** (Deployment, sem persistência, `maxmemory 32mb`, senha fora da linha de comando),
  com dois usos:
  1. **armazenamento do throttling** (`@nestjs/throttler`): cadastro 10/h por IP, login 5/min
     por IP + e-mail e 30/min por IP, upload 30/min e exclusão de conta 5/min por usuário; as
     chaves são hashes (o IP não fica em claro) e expiram sozinhas. Se o Redis cair, o
     throttling **libera** (fail-open) em vez de derrubar a API;
  2. **cache read-through** de `Idempotency-Key` → `videoId` por 24 h (chave
     `fiapx:idem:<userId>:<sha256(key)>`), apoiado no índice único `(user_id, idempotency_key)`
     do Postgres, que é a fonte da verdade.
- Nada de cache de dados mutáveis (listagem, status).

## Consequências

**Positivas (+)**

- Limites corretos com qualquer número de réplicas.
- O valor em cache nunca muda (uma chave de idempotência sempre aponta para o mesmo vídeo): não
  há risco de dado velho nem invalidação.
- Redis fora do ar não quebra o upload (cai para o Postgres) nem o login (fail-open).

**Negativas (−)**

- Enquanto o Redis estiver fora, não há limite de tentativas.
- Mais um componente para operar, com uso modesto.

## Alternativas rejeitadas

| Alternativa | Por que não |
|---|---|
| Throttling em memória | limite por réplica, multiplicado pela escala |
| Throttling no Postgres | escrita no banco a cada requisição limitada |
| Cache da listagem de vídeos | status velho na tela de acompanhamento e invalidação a cada transição |
| Sem Redis | contraria a stack recomendada e perde o limite compartilhado entre réplicas |

## Onde está

- `apps/video-api/src/shared/infrastructure/throttling/` (`throttle.ts`, `fail-open-throttler.storage.ts`)
- `apps/video-api/src/modules/videos/infrastructure/idempotency/redis-idempotency.cache.ts`
- `infra/k8s/base/data/redis/deployment.yaml`
