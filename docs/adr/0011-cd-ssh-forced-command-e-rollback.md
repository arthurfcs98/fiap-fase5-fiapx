# ADR-0011: CD por SSH com forced command e rollback automático

- Status: aceita
- Data: 2026-09-28

## Contexto

Cada push na `main` que passa no CI deve chegar sozinho ao K3s da VM. Mas a VM hospeda outros
projetos: uma credencial do CI que vaze não pode dar acesso amplo ao host nem ao cluster. A API
do Kubernetes (6443) não é exposta à internet. Tags de imagem são mutáveis. E todo deploy
precisa ter volta.

## Decisão

- Job `deploy` no GitHub Actions, só no push na `main`, depois do `ci-ok` e da publicação das
  imagens; environment `production` (secrets `VM_HOST`, `VM_SSH_KEY`, `VM_KNOWN_HOSTS`, que só
  jobs da `main` leem); um deploy por vez (grupo de concorrência).
- **SSH com chave restrita**: `authorized_keys` com `restrict,command="/opt/fiapx/bin/deploy.sh"`.
  A chave só consegue pedir `deploy <sha40>`, `rollback` ou `status` (sem shell, PTY, túnel ou
  sftp). Host key fixado (sem confiar na primeira conexão). O usuário `fiapx-deploy` não tem
  sudo nem acesso ao Docker; o kubeconfig dele é de uma ServiceAccount que só enxerga o namespace
  `fiapx`, sem Secrets, RBAC nem `exec`.
- **`deploy.sh`** (fonte em `infra/vm/deploy.sh`), rodando destacado e com lock:
  1. confere que o SHA está na `main`, recusa downgrade e SHAs que já falharam;
  2. resolve no GHCR (pull anônimo) o **digest** das imagens `sha-<7>` dos 3 apps;
  3. renderiza `infra/k8s/overlays/prod` com os digests e faz `apply --dry-run=server`
     (RBAC, Pod Security, quota, schema);
  4. camada de dados → Jobs de setup (`garage-init`, `rabbitmq-init`) → Jobs de migração →
     apply do resto → rollout (Deployments, StatefulSets, DaemonSets) → smoke interno;
  5. qualquer falha **reaplica o manifesto renderizado da release anterior** e marca o SHA como
     ruim.
- Depois, o Actions faz o **smoke público**: `/api/health/live` precisa devolver a versão
  `sha-<7>` do commit (gravada na imagem pelo CI); se não, pede `rollback`.
- Rollback manual: workflow `rollback.yml` (*Run workflow*), no mesmo grupo de concorrência.

## Consequências

**Positivas (+)**

- Uma chave vazada só consegue reimplantar commits da `main` (que passaram no CI) ou voltar uma
  versão.
- Nada da API do Kubernetes exposto; nenhum agente extra na VM.
- Deploy imutável (digest) e rollback completo (ConfigMaps, HPA, Ingress e ScaledObject voltam
  juntos com os Deployments).
- O log do deploy aparece ao vivo no Actions: evidência visível para a banca.

**Negativas (−)**

- O schema do banco nunca volta no rollback: as migrações precisam ser compatíveis com a versão
  anterior (expandir e depois contrair).
- Passos fora do CD, feitos pelo root: Secrets, RBAC, namespace e quota. Uma mudança que precise
  deles (ex.: os usuários do RabbitMQ por serviço) exige passos manuais antes e depois do deploy.
- Rollback de um passo (a release anterior registrada).
- Deploy demorado quando há vídeo em processamento: o worker em `Recreate` espera até 720 s o
  vídeo em curso, então o `deploy.sh` espera o rollout por até 900 s e o job do Actions tem 45
  minutos.

## Alternativas rejeitadas

| Alternativa | Por que não |
|---|---|
| GitOps por pull (Argo CD, Flux) | mais componentes numa VM com orçamento apertado; o push deixa a evidência no Actions |
| Expor a API do K3s aos runners | superfície de ataque na internet |
| Runner self-hosted na VM | um processo do CI com acesso ao host dos vizinhos |
| `kubectl rollout undo` | volta uma revisão de cada Deployment, mas não desfaz ConfigMap, HPA, Ingress nem ScaledObject |
| Implantar pela tag `:main` | tag mutável: o que roda deixa de ser o que foi testado |

## Onde está

- `.github/workflows/ci.yml` (jobs `images` e `deploy`) e `.github/workflows/rollback.yml`
- `infra/vm/deploy.sh` e `infra/vm/40-deployer-access.sh`
- `infra/vm/k8s/deployer-rbac.yaml`
- [`infra/vm/README.md`](../../infra/vm/README.md), seções 6.5, 6.6 e 8
