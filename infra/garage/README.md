# Garage (object storage S3) — dev local e CI

O [Garage](https://garagehq.deuxfleurs.fr/) substitui o MinIO (repositório arquivado) como
storage S3-compatível do FIAP Frames. Aqui ele roda como **nó único**.

| Arquivo | Para quê |
|---|---|
| `garage.toml` | Configuração do nó único (`replication_factor = 1`, SQLite, S3 na 3900, admin na 3903). Sem segredos. |
| `init.mjs` | One-shot idempotente (container `garage-init`): layout, chave S3 e buckets `fiapx-raw` e `fiapx-zips`. |

## Segredos

Todos vêm do `.env` gerado por `scripts/dev-secrets.sh` (nunca commitado):

- `GARAGE_RPC_SECRET`: 32 bytes em hex, exigido pelo Garage;
- `GARAGE_ADMIN_TOKEN`: token Bearer da Admin API (só o `garage-init` usa);
- `GARAGE_METRICS_TOKEN`: token do `/metrics` (no K8s, o Prometheus coleta com ele);
- `S3_ACCESS_KEY_ID` (`GK` + 24 hex) e `S3_SECRET_ACCESS_KEY` (64 hex): a chave S3 local.
  O `init.mjs` **importa** essa chave no Garage. Como as credenciais ficam no `.env`, elas
  continuam válidas depois de um `make down-v` (o init reimporta a mesma chave). Se a chave
  já existir no volume com **outro** segredo (o `.env` mudou e o volume não), o init falha
  com a causa, em vez de deixar os apps quebrarem com erro de assinatura S3: restaure o
  segredo antigo ou rode `make down-v`.

## Comandos equivalentes com o CLI `garage`

O que o `init.mjs` faz pela Admin API v2, feito à mão com o CLI dentro do container:

```bash
docker compose exec garage /garage status                      # pega o ID do nó
docker compose exec garage /garage layout assign -z dc1 -c 10G <node_id>
docker compose exec garage /garage layout apply --version 1
docker compose exec garage /garage key import --yes -n fiapx-local "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY"
docker compose exec garage /garage bucket create fiapx-raw
docker compose exec garage /garage bucket create fiapx-zips
docker compose exec garage /garage bucket allow --read --write fiapx-raw --key fiapx-local
docker compose exec garage /garage bucket allow --read --write fiapx-zips --key fiapx-local
docker compose exec garage /garage bucket list
```

## Acesso local com um cliente S3

```bash
set -a; . ./.env; set +a
AWS_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY \
  aws --endpoint-url http://localhost:3900 --region garage s3 ls
```

## Em produção (K3s): o que foi construído

O plano da etapa E3 era mover esta lógica para um one-shot `storage-init` em `libs/storage`, com
quotas de 2 GiB (raw) e 6 GiB (zips) e lifecycle de 7 dias no bucket. Não foi assim. O que existe:

- **Job `garage-init`** do K8s ([`infra/k8s/base/data/garage/garage-init.mjs`](../k8s/base/data/garage/garage-init.mjs),
  fase `setup` de cada deploy, idempotente): layout do nó, **uma chave por serviço** com
  permissão por bucket (`svc-api`: leitura e escrita nos dois buckets, porque a retenção e a
  eliminação de conta apagam objetos; `svc-worker`: só leitura no `fiapx-raw`, leitura e escrita
  no `fiapx-zips`) e **quotas de 1 GiB (`fiapx-raw`) e 2,5 GiB (`fiapx-zips`)**, que cabem no
  disco reservado aos volumes na VM. As chaves são geradas pelo
  `infra/k8s/scripts/bootstrap-secrets.sh`.
- **Sem lifecycle no bucket**: a retenção é feita pelo `video-api` (vídeo original apagado quando
  o processamento termina, zip apagado depois de `ZIP_RETENTION_DAYS`, varredura de hora em hora
  de sobras e de uploads multipart interrompidos). Detalhes: `docs/lgpd.md`, seção 3.
- Quota estourada: no upload, `503 X0003` com `Retry-After`; no zip do worker, o vídeo termina
  `FAILED P0007` (o alerta `FiapxZipStorageHigh` avisa a partir de 2 GiB).
- O compose (dev e CI) continua com o `init.mjs` desta pasta: uma chave só (`fiapx-local`), sem
  quotas.
- `garage.toml` tem uma cópia em `infra/k8s/base/data/garage/`; o `infra/k8s/scripts/validate.sh`
  falha se as duas divergirem.
