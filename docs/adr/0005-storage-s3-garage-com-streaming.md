# ADR-0005: Storage S3-compatível com Garage e streaming

- Status: aceita
- Data: 2026-09-28

## Contexto

Vídeos (até 95 MiB) e zips precisam ser lidos e gravados por pods diferentes (`video-api` e
`video-worker`), com várias réplicas e pods efêmeros: disco local não serve. O projeto base
guardava tudo no disco do container e expunha as pastas publicamente.

Restrições: custo zero, tudo dentro da VM compartilhada (sem credenciais de nuvem de longa
duração), memória contida (um vídeo de 95 MiB não pode ir inteiro para a RAM) e teto de disco
para não afetar os vizinhos. O MinIO, escolha tradicional para S3 local, teve o repositório
comunitário arquivado.

## Decisão

- **Garage v2** (S3-compatível, binário único, metadados em SQLite, nó único), fixado por
  digest, como StatefulSet com PVC de 4Gi.
- Dois **buckets privados**: `fiapx-raw` (vídeos enviados, quota de 1 GiB) e `fiapx-zips`
  (resultados, quota de 2,5 GiB). Quota estourada no upload → `503 X0003` com `Retry-After`; no
  zip do worker → `FAILED P0007` sem retry. O gauge `fiapx_zip_storage_bytes` e o alerta
  `FiapxZipStorageHigh` (a partir de 2 GiB) avisam antes.
- **Uma chave por serviço** com permissão por bucket: `svc-api` (leitura e escrita nos dois:
  upload, download, retenção e eliminação) e `svc-worker` (só leitura no raw, leitura e escrita
  nos zips). Criadas pelo Job `garage-init` a cada deploy.
- Chaves de objeto só com UUIDs: `{userId}/{videoId}{ext}` e `{userId}/{videoId}.zip`
  (determinística, usada pela idempotência do worker), com metadados `video-id` e `frame-count`
  no zip.
- **Streaming de ponta a ponta**: upload do navegador direto para o storage (busboy →
  `@aws-sdk/lib-storage`, multipart), worker baixando para disco, zip montado em stream
  (`archiver` sem compressão: PNG já é comprimido) e download em stream do bucket pela API.
  No `video-api`, partes de 5 MiB com 1 em voo (~10 MiB de memória por upload) e no máximo
  `MAX_CONCURRENT_UPLOADS` (8) uploads por réplica: acima disso, `503 X0003` com `Retry-After`,
  antes de ler o corpo.
- Acesso só pela porta `IObjectStorage` (`libs/storage`), com `@aws-sdk/client-s3`,
  `forcePathStyle` e `S3_ENDPOINT` configurável.

## Consequências

**Positivas (+)**

- O mesmo código funciona com AWS S3 trocando `S3_ENDPOINT` e as credenciais.
- Memória estável independente do tamanho do vídeo.
- Menor privilégio por serviço e storage nunca exposto na borda.
- Quotas por bucket são o teto de disco do app (proteção dos vizinhos).

**Negativas (−)**

- Nó único, sem redundância e (ainda) sem backup dos buckets.
- O download passa pela API (banda e CPU do `video-api`), em troca de não expor o storage.
- A retenção do zip é feita por um job do `video-api`, não por lifecycle do bucket.

## Alternativas rejeitadas

| Alternativa | Por que não |
|---|---|
| MinIO | repositório comunitário arquivado; imagem sem correções de segurança recentes |
| AWS S3 | credenciais e custo de nuvem, latência a partir da VM e dependência de uma conta de estudante |
| Volume compartilhado entre pods | acopla os pods ao mesmo nó e ao mesmo disco; não é o padrão de um sistema que escala |
| Vídeos no Postgres | incha o banco, os backups e a memória do banco |
| URL pré-assinada direto no storage | exigiria publicar o storage num hostname próprio e CORS no bucket; fica como evolução para arquivos grandes |

## Onde está

- `libs/storage/src/` (`IObjectStorage`, `S3ObjectStorage`, chaves em `object-keys.ts`)
- `infra/k8s/base/data/garage/` (StatefulSet, `garage.toml`, `garage-init.mjs`) e `infra/garage/` (compose)
- `apps/video-api/src/modules/videos/interfaces/http/multipart-file.reader.ts`
- `apps/video-worker/src/modules/processing/infrastructure/zip/archiver-frame-archiver.ts`
