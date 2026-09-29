# ADR-0013: Migrações TypeORM em SQL executadas por one-shots

- Status: aceita
- Data: 2026-09-28

## Contexto

O schema dos dois bancos precisa ser versionado, revisável em PR, reproduzível do zero e
aplicado **antes** de a versão nova dos apps subir, sem corrida entre réplicas. O
`synchronize` do TypeORM (gerar o schema a partir das entidades) é perigoso em produção. O
enunciado pede o "script de criação do banco de dados".

## Decisão

- **Bancos e usuários** criados por `infra/postgres/init/00-create-databases.sh` na primeira
  inicialização do volume: `fiapx_video` e `fiapx_notification`, cada um com o próprio role
  dono, e `REVOKE ALL ... FROM PUBLIC`.
- **Schema por migrações TypeORM escritas em SQL puro**, registradas numa lista **explícita**
  (sem glob: o bundle do webpack não carrega arquivos por padrão de caminho), com
  `synchronize: false` e `migrationsRun: false` fixos no código. Cada migração roda na própria
  transação; as já aplicadas são puladas (tabela `migrations`).
- Aplicadas por um **one-shot** `node dist/migrate.js`, entrada extra da mesma imagem do app,
  que só precisa das variáveis `DB_*`:
  - compose: serviços `video-api-migrate` e `notification-migrate`; os apps esperam
    `service_completed_successfully`;
  - K3s: Jobs da fase `migrate`, que o `deploy.sh` roda antes do rollout (com sufixo do SHA).
- **Expandir e depois contrair**: o schema nunca volta no rollback do deploy, então uma migração
  precisa ser compatível com a versão anterior do código.
- **SQL legível** em `infra/db/schema/*.sql`, equivalente às migrações e conferido com
  `pg_dump --schema-only` (inclui a tabela `migrations` preenchida).

## Consequências

**Positivas (+)**

- O mesmo caminho no dev, no CI (compose do BDD) e em produção.
- Migrações revisadas como SQL; o schema do contrato é exatamente o que roda.
- Os apps sobem só depois do schema pronto; réplicas não disputam a migração.

**Negativas (−)**

- Sem "down" automático no deploy.
- A equivalência entre as migrações e o SQL legível é conferida à mão (evolução: job no CI).
- O app e a migração usam o mesmo role (dono do banco); um role só de migração daria menor
  privilégio em tempo de execução.

## Alternativas rejeitadas

| Alternativa | Por que não |
|---|---|
| `synchronize: true` | schema implícito, sem revisão e com risco de perda de dados |
| Migrar no startup do app (`migrationsRun`) | corrida entre réplicas e startup mais lento |
| Ferramenta externa (Flyway, golang-migrate) | mais uma imagem e mais um stack para manter |
| Só scripts SQL soltos | sem registro de quais versões já foram aplicadas |

## Onde está

- `apps/video-api/src/database/migrations/` e `apps/notification-service/src/database/migrations/`
  (hoje duas migrações em cada banco: a inicial `1790553600000` e a `1790640000000`, com o índice
  do histórico no `fiapx_video` e a tabela `deleted_users` + índice no `fiapx_notification`)
- `apps/*/src/migrate.ts`, `apps/video-api/src/database/migration-cli.ts`, `libs/common/src/database/typeorm.config.ts`
- `infra/k8s/jobs/video-api-migrate.yaml`, `infra/k8s/jobs/notification-migrate.yaml`, `compose.yaml`
- [`infra/db/README.md`](../../infra/db/README.md) e `infra/db/schema/`
