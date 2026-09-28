# Garage (object storage S3) — dev local e CI

O [Garage](https://garagehq.deuxfleurs.fr/) substitui o MinIO (repositório arquivado) como
storage S3-compatível do FIAP X. Aqui ele roda como **nó único**.

| Arquivo | Para quê |
|---|---|
| `garage.toml` | Configuração do nó único (`replication_factor = 1`, SQLite, S3 na 3900, admin na 3903). Sem segredos. |
| `init.mjs` | One-shot idempotente (container `garage-init`): layout, chave S3 e buckets `fiapx-raw` e `fiapx-zips`. |

## Segredos

Todos vêm do `.env` gerado por `scripts/dev-secrets.sh` (nunca commitado):

- `GARAGE_RPC_SECRET`: 32 bytes em hex, exigido pelo Garage;
- `GARAGE_ADMIN_TOKEN`: token Bearer da Admin API (só o `garage-init` usa);
- `GARAGE_METRICS_TOKEN`: token do `/metrics` (Prometheus, na E6);
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

## Próximos passos (E3)

A lógica migra para `libs/storage` (one-shot `storage-init` na imagem do `video-api`): uma
chave por serviço (`svc-api`, `svc-worker`) com permissão por bucket, quotas (2 GiB raw,
6 GiB zips) e lifecycle de 7 dias.
