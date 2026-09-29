# Registros de decisão de arquitetura (ADRs)

Cada ADR registra **uma** decisão importante do FIAP Frames: o contexto que a motivou, o que foi
decidido, as consequências (boas e ruins) e as alternativas rejeitadas. A visão geral da
arquitetura está em [`docs/arquitetura.md`](../arquitetura.md); os nomes exatos (filas, eventos,
tabelas, variáveis) em [`docs/arquitetura/contratos.md`](../arquitetura/contratos.md).

| ADR | Decisão | Status |
|---|---|---|
| [0001](0001-microsservicos-em-monorepo.md) | Três microsserviços num monorepo NestJS com libs compartilhadas | Aceita |
| [0002](0002-typescript-nestjs-no-worker.md) | TypeScript/NestJS também no worker, em vez de manter o Go do projeto base | Aceita |
| [0003](0003-rabbitmq-quorum-retry-dlq.md) | RabbitMQ com filas quorum, retry por filas com TTL e DLQ, em vez de Kafka ou BullMQ | Aceita |
| [0004](0004-outbox-e-consumidores-idempotentes.md) | Transactional Outbox no `video-api` e consumidores idempotentes | Aceita |
| [0005](0005-storage-s3-garage-com-streaming.md) | Storage S3-compatível com Garage (MinIO arquivado) e streaming de ponta a ponta | Aceita |
| [0006](0006-k3s-na-vm-compartilhada.md) | K3s na VM compartilhada, atrás do Caddy, com proteção dos vizinhos | Aceita |
| [0007](0007-autoescala-keda-e-hpa.md) | KEDA pelo tamanho da fila no worker e HPA por CPU no api | Aceita |
| [0008](0008-autenticacao-jwt-e-download-assinado.md) | Usuário e senha com JWT e download por URL assinada (HMAC) | Aceita |
| [0009](0009-observabilidade-e-slos.md) | Prometheus, Grafana, Loki e Grafana Alloy, com SLOs e alertas por taxa de queima | Aceita |
| [0010](0010-lgpd-by-design.md) | LGPD desde o desenho (privacy by design) | Aceita |
| [0011](0011-cd-ssh-forced-command-e-rollback.md) | CD por SSH com forced command, imagens por digest e rollback automático | Aceita |
| [0012](0012-redis-throttling-e-cache.md) | Redis para throttling e cache de `Idempotency-Key` | Aceita |
| [0013](0013-migracoes-sql-e-one-shots.md) | Migrações TypeORM em SQL executadas por one-shots antes do deploy | Aceita |

Todas foram tomadas e implementadas em 2026-09-28, durante a construção desta fase.

## Formato

```markdown
# ADR-NNNN: título curto no imperativo

- Status: proposta | aceita | substituída por ADR-XXXX
- Data: AAAA-MM-DD

## Contexto          (o problema e as forças em jogo)
## Decisão           (o que foi decidido, com os números que importam)
## Consequências     (+ positivas / − negativas)
## Alternativas rejeitadas (e por quê)
## Onde está          (arquivos do repositório que implementam a decisão)
```

Para propor uma decisão nova: copie o formato, use o próximo número e abra um PR que também
atualize esta tabela. Uma decisão que muda outra não apaga a antiga: a antiga passa a
"substituída por".

## Decisões de infraestrutura mais finas

As decisões de baixo nível da instalação na VM (Ingress, firewall, reservas do kubelet, discos,
IPv6, TLS da Cloudflare, onde fica a observabilidade) estão numeradas de D1 a D23 em
[`infra/vm/README.md`](../../infra/vm/README.md), seção 2, e as diferenças entre o plano e os
manifestos em [`infra/k8s/README.md`](../../infra/k8s/README.md), seção 10. O ADR-0006 resume
as que importam para a arquitetura.
