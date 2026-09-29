# infra/db: scripts de criação do banco e dos demais recursos

> Entregável do enunciado: **"script de criação do banco de dados ou de outros recursos
> utilizados na solução"**. Este arquivo é o índice de todos eles: o que cada script cria, quem o
> roda, quando, e como conferir. Visão geral dos dados: [`docs/arquitetura.md`](../../docs/arquitetura.md),
> seção 7. Nomes de tabelas e colunas: [`docs/arquitetura/contratos.md`](../../docs/arquitetura/contratos.md),
> seções 5, 6 e 12.

## Resumo

| Recurso | Script | Quem roda e quando | Rodar de novo é seguro? |
|---|---|---|---|
| Bancos e usuários do PostgreSQL | [`infra/postgres/init/00-create-databases.sh`](../postgres/init/00-create-databases.sh) | entrypoint oficial do Postgres, **só na 1ª inicialização do volume** (compose e StatefulSet do K3s) | não roda de novo (o volume já existe) |
| Schema do `fiapx_video` (**caminho oficial**) | migrações em [`apps/video-api/src/database/migrations/`](../../apps/video-api/src/database/migrations) (ordem em `index.ts`) | one-shot `video-api-migrate` (compose) ou Job `video-api-migrate` (K3s), antes dos apps | sim (migração aplicada é pulada) |
| Schema do `fiapx_notification` (**caminho oficial**) | migrações em [`apps/notification-service/src/database/migrations/`](../../apps/notification-service/src/database/migrations) (ordem em `index.ts`) | one-shot ou Job `notification-migrate`, antes dos apps | sim |
| **Schema legível, equivalente às migrações** | [`schema/fiapx_video.sql`](schema/fiapx_video.sql) e [`schema/fiapx_notification.sql`](schema/fiapx_notification.sql) | leitura; ou criação manual com `psql` | não: a 2ª execução falha sem mudar nada (transação) |
| Exchanges, filas e bindings do RabbitMQ | [`libs/messaging/src/topology.ts`](../../libs/messaging/src/topology.ts) | K3s: initContainer do Job `rabbitmq-init` (`setup-topology.js`) antes dos apps; depois, **cada serviço** a redeclara a cada conexão; compose: os serviços a criam | sim (declaração idempotente) |
| Usuários por serviço, usuário do KEDA, limites e TTL das DLQs no RabbitMQ | [`infra/k8s/base/data/rabbitmq/rabbitmq-init.mjs`](../k8s/base/data/rabbitmq/rabbitmq-init.mjs) (+ [`30-fiapx.conf`](../k8s/base/data/rabbitmq/30-fiapx.conf) e `enabled_plugins`) | Job `rabbitmq-init` a cada deploy | sim |
| Layout, chaves S3, buckets, permissões e quotas do Garage | [`infra/k8s/base/data/garage/garage-init.mjs`](../k8s/base/data/garage/garage-init.mjs) (K3s) e [`infra/garage/init.mjs`](../garage/init.mjs) (compose) | Job `garage-init` a cada deploy; one-shot `garage-init` no compose | sim |
| Segredos | [`scripts/dev-secrets.sh`](../../scripts/dev-secrets.sh) (`.env` local) e [`infra/k8s/scripts/bootstrap-secrets.sh`](../k8s/scripts/bootstrap-secrets.sh) (Secrets de produção) | desenvolvedor / root na VM | sim (só cria o que falta, nunca sobrescreve) |
| Cluster, borda, firewall, KEDA, namespace, RBAC e acesso do CD | [`infra/vm/`](../vm/) (`00` a `40-*.sh`, `k8s/*.yaml`) | root na VM, uma vez (dry-run por padrão) | sim (idempotentes e reversíveis) |
| Aplicação, dados e observabilidade no Kubernetes | [`infra/k8s/`](../k8s/) (Kustomize) | `infra/vm/deploy.sh`, chamado pelo CD | sim |

## 1. Bancos e usuários

[`infra/postgres/init/00-create-databases.sh`](../postgres/init/00-create-databases.sh) roda
dentro do container do Postgres, como superusuário, **apenas na primeira inicialização do
volume** (regra do entrypoint oficial da imagem):

```sql
CREATE ROLE fiapx_video LOGIN PASSWORD :'video_pw';
CREATE DATABASE fiapx_video OWNER fiapx_video;
REVOKE ALL ON DATABASE fiapx_video FROM PUBLIC;

CREATE ROLE fiapx_notification LOGIN PASSWORD :'notif_pw';
CREATE DATABASE fiapx_notification OWNER fiapx_notification;
REVOKE ALL ON DATABASE fiapx_notification FROM PUBLIC;
```

- Um banco e um usuário **por serviço** (database per service): o `notification-service` não
  consegue ler o banco do `video-api`, e vice-versa.
- As senhas vêm do ambiente (`VIDEO_DB_PASSWORD`, `NOTIF_DB_PASSWORD`), nunca do Git: no compose
  pelo `.env` gerado por `scripts/dev-secrets.sh`; no K3s pelo Secret `fiapx-postgres`.
- No compose a pasta é montada em `/docker-entrypoint-initdb.d`; no K3s o mesmo arquivo vai num
  ConfigMap a partir da cópia [`infra/k8s/base/data/postgres/init/`](../k8s/base/data/postgres/init)
  (o `infra/k8s/scripts/validate.sh` falha se as duas cópias divergirem).

## 2. Schema: migrações (caminho oficial)

- Migrações TypeORM escritas em **SQL puro**, numa lista explícita (`migrations/index.ts`), com
  `synchronize: false` e `migrationsRun: false` fixos no código. Cada migração roda na própria
  transação e as já aplicadas são puladas (tabela `migrations`). Decisão:
  [ADR-0013](../../docs/adr/0013-migracoes-sql-e-one-shots.md).
- Quem aplica é o **one-shot `node dist/migrate.js`**, uma entrada extra da mesma imagem do app
  que só precisa das variáveis `DB_*`:

| Ambiente | `fiapx_video` | `fiapx_notification` | Quando |
|---|---|---|---|
| Compose (dev e CI) | serviço `video-api-migrate` | serviço `notification-migrate` | `make up`: depois do Postgres saudável e antes dos apps (`service_completed_successfully`) |
| K3s (produção) | Job [`video-api-migrate`](../k8s/jobs/video-api-migrate.yaml) | Job [`notification-migrate`](../k8s/jobs/notification-migrate.yaml) | a cada deploy, fase `migrate` do `deploy.sh`, antes do rollout dos apps |

Rodar à mão no compose (idempotente):

```bash
docker compose run --rm video-api-migrate
docker compose run --rm notification-migrate
# {"level":"info",...,"msg":"Nenhuma migração pendente","database":"fiapx_video","applied":[]}
```

## 3. Schema legível: `schema/*.sql`

[`schema/fiapx_video.sql`](schema/fiapx_video.sql) e
[`schema/fiapx_notification.sql`](schema/fiapx_notification.sql) são o mesmo schema de **todas**
as migrações de cada banco (hoje duas em cada: a inicial `1790553600000` e a `1790640000000`),
escrito para ser lido: comentários em cada tabela e coluna importante, e a regra de negócio por
trás de cada índice. Também servem para criar o schema à mão (por exemplo, num Postgres
gerenciado):

```bash
# depois de criar o banco e o role (seção 1), como o DONO do banco:
psql -v ON_ERROR_STOP=1 -h <host> -U fiapx_video -d fiapx_video -f infra/db/schema/fiapx_video.sql
psql -v ON_ERROR_STOP=1 -h <host> -U fiapx_notification -d fiapx_notification -f infra/db/schema/fiapx_notification.sql
```

- Cada arquivo roda numa transação (`BEGIN`/`COMMIT`): cria tudo ou nada.
- Cada arquivo também cria a tabela `migrations` do TypeORM com as migrações equivalentes
  registradas. Assim, se depois alguém rodar o one-shot `node dist/migrate.js`, ele responde
  "Nenhuma migração pendente" em vez de tentar criar as tabelas de novo.
- A fonte da verdade continua sendo a migração. **Mudou uma migração? Atualize o `.sql` no mesmo
  PR** e refaça a conferência abaixo.

### Como foi conferido

Em 2026-09-28, com PostgreSQL 16.15 (a mesma imagem e digest do `compose.yaml`) e o
`00-create-databases.sh` real:

1. banco A: as classes de migração reais, na ordem do `index.ts` de cada app, aplicadas pelo
   runner do TypeORM (uma transação por migração, como o one-shot), com o role dono do banco;
2. banco B: o `.sql` deste diretório aplicado com `psql`, com o mesmo role;
3. `pg_dump --schema-only` dos dois: **idênticos** (tabelas, tipos, defaults, constraints com os
   mesmos nomes, índices, sequências e a tabela `migrations`), com e sem donos e privilégios;
4. o runner do TypeORM rodado sobre o banco B não aplicou nada (`applied: []`).

Para repetir com o stack local:

```bash
make up    # o one-shot video-api-migrate aplica a migração oficial

# 1. schema criado pela migração
docker compose exec -T postgres pg_dump -U fiapx -d fiapx_video --schema-only --no-owner --no-privileges \
  | grep -v '^\\' > /tmp/migracao.sql
# 2. schema criado pelo script legível, num banco descartável com o mesmo dono
docker compose exec -T postgres psql -U fiapx -d fiapx -c 'CREATE DATABASE conferencia OWNER fiapx_video'
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -q -U fiapx_video -d conferencia \
  < infra/db/schema/fiapx_video.sql
docker compose exec -T postgres pg_dump -U fiapx -d conferencia --schema-only --no-owner --no-privileges \
  | grep -v '^\\' > /tmp/script.sql
diff /tmp/migracao.sql /tmp/script.sql && echo "idênticos"
docker compose exec -T postgres psql -U fiapx -d fiapx -c 'DROP DATABASE conferencia'
```

(O `grep -v '^\\'` tira as linhas `\restrict`/`\unrestrict` que o `pg_dump` 16 recente grava com
uma chave aleatória a cada execução. Para o outro banco, troque `fiapx_video` por
`fiapx_notification` nos comandos.)

## 4. Demais recursos

### 4.1 RabbitMQ

- **Topologia em código**: [`libs/messaging/src/topology.ts`](../../libs/messaging/src/topology.ts)
  (`buildTopology()`) descreve 2 exchanges (`fiapx.events` topic, `fiapx.dlx` direct), 20 filas
  quorum (4 principais, cada uma com `.retry.1..3` e `.dlq`) e 10 bindings, declarados por
  `assertTopology` ([`topology-setup.ts`](../../libs/messaging/src/topology-setup.ts)). Nenhum
  consumidor começa antes de a fila existir. Mudar um argumento de fila existente falha com
  `PRECONDITION_FAILED` de propósito (exige migrar a fila).
- **Job [`rabbitmq-init`](../k8s/jobs/rabbitmq-init.yaml)** (K3s, fase `setup` de cada deploy),
  em dois passos:
  1. initContainer `topology`: roda o entry `setup-topology.js` da imagem do `video-api` com o
     administrador e **cria** a topologia do código (os usuários por serviço só conseguem
     redeclará-la, não criar filas com dead-letter);
  2. container `rabbitmq-init` ([`rabbitmq-init.mjs`](../k8s/base/data/rabbitmq/rabbitmq-init.mjs)):
     cria **um usuário por serviço** (`fiapx-api`, `fiapx-worker`, `fiapx-notification`) com
     permissões mínimas e *topic permissions* (cada um só publica as routing keys que são dele),
     o usuário `fiapx-keda` (tag `monitoring`, sem acesso a mensagens) e as operator policies
     `fiapx-limits` (64 MiB por fila) e `fiapx-dlq-limits` (DLQs com 64 MiB, `reject-publish` e
     TTL de 7 dias, por LGPD).
- **Configuração do broker**: [`30-fiapx.conf`](../k8s/base/data/rabbitmq/30-fiapx.conf)
  (alarme de memória em 300 MiB, disco livre mínimo, WAL das filas quorum, métricas por fila) e
  `enabled_plugins` com o shovel (redrive das DLQs pelo "Move messages" da UI), em
  `infra/k8s/base/data/rabbitmq/` e em [`infra/rabbitmq/`](../rabbitmq/) (compose).
- No compose não há `rabbitmq-init`: os 3 serviços usam o administrador do `.env` e criam a
  topologia ao conectar.

### 4.2 Garage (storage S3)

| Ambiente | Script | O que cria |
|---|---|---|
| Compose | [`infra/garage/init.mjs`](../garage/init.mjs) (one-shot `garage-init`) | layout do nó único, uma chave S3 local (`fiapx-local`) e os buckets `fiapx-raw` e `fiapx-zips` com leitura e escrita |
| K3s | [`infra/k8s/base/data/garage/garage-init.mjs`](../k8s/base/data/garage/garage-init.mjs) (Job `garage-init`) | layout; **duas** chaves com menor privilégio (`svc-api`: leitura e escrita nos dois buckets; `svc-worker`: só leitura no raw, leitura e escrita nos zips); os buckets; e as quotas (1 GiB raw, 2,5 GiB zips) |

Configuração do nó: `infra/garage/garage.toml` (cópia conferida em `infra/k8s/base/data/garage/`).
Comandos equivalentes com o CLI `garage`: [`infra/garage/README.md`](../garage/README.md).

### 4.3 Segredos

- **Local**: `scripts/dev-secrets.sh` gera o `.env` (gitignored) a partir do `.env.example`, com
  valores aleatórios; rodar de novo nunca sobrescreve o que existe.
- **Produção**: `infra/k8s/scripts/bootstrap-secrets.sh`, como root na VM (o CD não consegue
  criar nem ler Secrets, de propósito). Dry-run por padrão; gera os valores com `openssl` direto
  em arquivos temporários e cria os Secrets com `--from-file` (nada na tela, no histórico ou no
  Git). Lista dos Secrets e rotação: [`infra/k8s/README.md`](../k8s/README.md), seção 8.

### 4.4 Cluster e VM

Scripts do root, todos dry-run por padrão, idempotentes e reversíveis (runbook em
[`infra/vm/README.md`](../vm/README.md)):

| Script | Cria |
|---|---|
| `20-firewall.sh` | regras do UFW na interface do CNI e a guarda `fiapx-netguard` (IPv4 e IPv6) |
| `10-install-k3s.sh` | discos em loop (20 GiB do K3s, 8 GiB dos volumes), configuração do K3s e do kubelet, instalação da versão fixada |
| `30-ingress.sh` | Traefik (HelmChart, NodePort só na bridge da borda) e, com `--caddy`, os sites `fiapx.caddy` e `frames.caddy` no Caddy da borda |
| `35-keda.sh` | KEDA (HelmChart no namespace `keda`) |
| `40-deployer-access.sh` | namespace `fiapx` com quota, LimitRange, PriorityClasses e política de admissão (`k8s/namespace-guard.yaml`), RBAC do CD e da observabilidade, usuário `fiapx-deploy` com forced command e o `deploy.sh` |

## 5. Ordem de criação do zero

**Local** (`make up`, ver o README da raiz):

1. `scripts/dev-secrets.sh` gera o `.env`;
2. infraestrutura: Postgres (roda o `00-create-databases.sh` no volume novo), Redis, RabbitMQ,
   Garage e Mailpit, até ficarem saudáveis;
3. one-shots: `garage-init`, `video-api-migrate` e `notification-migrate`;
4. os 3 apps, que declaram a topologia do RabbitMQ ao conectar.

**Produção** (K3s na VM):

1. root: scripts de `infra/vm/` na ordem da seção 5 do [`infra/vm/README.md`](../vm/README.md)
   (`20` antes de `10`, depois `30`, `35` e `40`);
2. root: `infra/k8s/scripts/bootstrap-secrets.sh --yes` (chave do Resend por arquivo);
3. push na `main`: o CD aplica a camada de dados (o Postgres roda o `00-create-databases.sh` no
   primeiro volume), os Jobs de setup (`garage-init`; `rabbitmq-init`, que cria a topologia e
   os usuários do broker), os Jobs de migração e só então os apps.
