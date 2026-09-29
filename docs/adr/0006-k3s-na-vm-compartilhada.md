# ADR-0006: K3s na VM compartilhada, atrás do Caddy, com proteção dos vizinhos

- Status: aceita
- Data: 2026-09-28

## Contexto

A banca precisa do sistema no ar 24/7, e o curso trabalha Kubernetes (HPA, autoescala, probes,
rollouts). Havia duas opções de ambiente:

- **AWS Academy (EKS)**: crédito limitado de estudante (um cluster EKS consome o crédito em
  poucos dias), sessões temporárias de credencial e recursos restritos;
- **uma VM já disponível** que **já roda outros projetos em produção** em Docker, atrás de um
  proxy de borda (Caddy) dono das portas 80/443.

Colocar o FIAP Frames nessa VM não pode, em hipótese nenhuma, derrubar ou degradar os
vizinhos: disputa de memória, CPU e disco, portas, regras de firewall do Docker e acesso do CI.

## Decisão

- **K3s de nó único** (versão fixada) na VM, instalado por scripts **dry-run por padrão,
  idempotentes e reversíveis** (`infra/vm/`), com snapshot do estado anterior.
- **Borda**: o edge-caddy continua sendo a única porta 80/443; ganha só os sites
  `frames.asdevit.com` e `fiapx.asdevit.com`, validados num container descartável antes do
  reload. Ele repassa ao **Traefik** (Ingress Controller; o ingress-nginx foi aposentado),
  exposto como NodePort **só no IP privado da bridge docker da borda**. TLS termina no Caddy;
  Cloudflare na frente, com a regra SSL Full (strict) no endereço oficial `frames.asdevit.com`.
  Do Caddy ao Traefik e aos pods o tráfego é HTTP, mas não sai do host (o host técnico
  `fiapx.asdevit.com` ainda está fora da regra: pendência P13 do `infra/vm/README.md`).
- **Namespace `fiapx`** com ResourceQuota (requests 1600m/2304Mi, limits 7 CPU/4608Mi, 20 pods,
  8Gi de volumes, zero NodePort/LoadBalancer), LimitRange, Pod Security `baseline` (os pods
  seguem `restricted`), PriorityClasses próprias e uma política de admissão que recusa pods
  Guaranteed e classes de prioridade do sistema.
- **Memória e CPU**: reservas do kubelet que criam uma parede de memória para todos os pods
  (RAM − 3 GiB); todo pod com request < limit (num OOM global, os pods do fiapx morrem antes dos
  processos do host); worker com teto de 1 vCPU e no máximo 2 réplicas.
- **Disco**: tudo do K3s num arquivo loop de 20 GiB e os volumes num loop próprio de 8 GiB
  (PVC cheio não trava o kubelet nem enche o disco dos vizinhos).
- **Rede**: regras do UFW só na interface do CNI e uma guarda na tabela `raw` do iptables
  (IPv4 e IPv6) para que containers vizinhos não alcancem os pods e a internet não alcance as
  portas do K3s; `servicelb` desligado; controlador de NetworkPolicy desligado (ele reescreveria
  a tabela filter inteira, inclusive as regras do Docker).
- **Observabilidade no próprio namespace `fiapx`**: o CD só enxerga esse namespace e não cria
  RBAC; o RBAC de leitura do Prometheus e do Alloy é aplicado uma vez pelo root.
- **Desenvolvimento e CI** continuam no Docker Compose (o mesmo sistema, com Mailpit).

## Consequências

**Positivas (+)**

- Kubernetes de verdade em produção (HPA, KEDA, probes, rollouts, Jobs) sem custo adicional.
- Os vizinhos ficam protegidos por limites duros (parede de memória, peso de CPU, discos em
  loop, quota), não por boa vontade.
- Tudo reproduzível e revisável: scripts e manifestos no Git, validados no CI (kubeconform,
  regras do deploy e da quota) e num K3s local (k3d) com as mesmas grades da VM.

**Negativas (−)**

- Nó único: sem alta disponibilidade; a VM é um ponto único de falha (compartilhado com os
  vizinhos).
- Teto baixo de recursos (2 workers); o pico vira fila, não mais réplicas.
- Operação mais complexa, e alguns passos só o root faz (Secrets, RBAC, port-forward).

## Alternativas rejeitadas

| Alternativa | Por que não |
|---|---|
| EKS no AWS Academy | o crédito acaba em poucos dias com o cluster ligado; sessões temporárias atrapalham o CD e a demo |
| Docker Compose em produção | o mais simples e aceito pelo enunciado, mas não demonstra HPA, KEDA e operação em Kubernetes (continua no dev e no CI) |
| ingress-nginx | aposentado; não recebe mais correções de segurança |
| Uma VM dedicada | custo extra |
| Expor a API do K3s (6443) | superfície de ataque desnecessária; o CD entra por SSH restrito (ADR-0011) |

## Onde está

- [`infra/vm/README.md`](../../infra/vm/README.md): decisões D1 a D23, orçamento de recursos, riscos, revisão de segurança
- `infra/vm/k8s/namespace-guard.yaml` (quota, LimitRange, PriorityClasses, política)
- [`infra/k8s/README.md`](../../infra/k8s/README.md) e `infra/k8s/overlays/prod`
- `infra/vm/frames.caddy`, `infra/vm/fiapx.caddy`, `infra/vm/30-ingress.sh`
- [`docs/estudos/k3s-na-vm-compartilhada.md`](../estudos/k3s-na-vm-compartilhada.md) (estudo de fundo)
