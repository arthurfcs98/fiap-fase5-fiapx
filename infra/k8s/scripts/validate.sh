#!/usr/bin/env bash
# =============================================================================
# infra/k8s/scripts/validate.sh — valida os manifestos SEM cluster (local e no CI).
#
#   infra/k8s/scripts/validate.sh            # tudo (precisa de Docker para as ferramentas)
#   SKIP_DOCKER=1 infra/k8s/scripts/validate.sh   # só o que não usa Docker
#
# O que confere:
#    1. kustomize renderiza overlays/prod, overlays/local, jobs e overlays/local/jobs;
#    2. regras do deploy.sh e orçamento da quota (check-manifests.mjs, lendo os arquivos do SRE);
#    3. schema de cada objeto (kubeconform, modo estrito; CRDs do KEDA pelo catálogo);
#    4. Prometheus: config, regras e testes unitários das regras (promtool);
#    5. Loki: config (-verify-config); Alloy: sintaxe/semântica (validate) e formatação (fmt);
#    6. dashboards do Grafana: JSON válido, uid/título do contrato, datasources existentes;
#    7. nomes do contrato (8 alertas, 2 dashboards) presentes;
#    8. cópias em sincronia com o compose (init do Postgres, garage.toml);
#    9. shellcheck nos scripts e "node --check" nos .mjs.
# Imagens das ferramentas: as MESMAS (tag + digest) dos manifestos, lidas deles.
# =============================================================================
set -Eeuo pipefail
export LC_ALL=C

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
K8S=$ROOT/infra/k8s
VM=$ROOT/infra/vm/k8s
OUT=$(mktemp -d)
trap 'rm -rf -- "$OUT"' EXIT
KUBECONFORM_IMAGE=ghcr.io/yannh/kubeconform:v0.8.0@sha256:faffaf43f95aa6425306e1ab8d6fcad72acb9049158f38e574c085ea1ec0f64e
KUBERNETES_VERSION=${KUBERNETES_VERSION:-1.33.0}   # maior versão com schemas publicados no kubeconform

failures=0
step() { printf '\n==> %s\n' "$*"; }
ok()   { printf '    ok: %s\n' "$*"; }
bad()  { printf '    FALHOU: %s\n' "$*" >&2; failures=$((failures + 1)); }
run()  { local label=$1; shift; if "$@"; then ok "$label"; else bad "$label"; fi; }

image_of() {  # primeira imagem "<repo>:<tag>@sha256:..." de um repositório nos manifestos
  grep -rhoE "image: $1:[^[:space:]]+" "$K8S" | head -n1 | sed 's/^image: //'
}

# ------------------------------------------------------------------ 1. kustomize
step "kustomize"
render() {  # $1 dir, $2 saída
  if kubectl kustomize "$K8S/$1" > "$OUT/$2" 2> "$OUT/$2.err"; then
    ok "$1 ($(grep -c '^kind:' "$OUT/$2") objetos)"
  else
    bad "$1: $(cat "$OUT/$2.err")"
  fi
}
render overlays/prod prod.yaml
render overlays/local local.yaml
render jobs jobs.yaml
render overlays/local/jobs local-jobs.yaml

# ------------------------------------------------------------------ 2. regras do deploy.sh
step "regras do deploy.sh e orçamento (infra/vm/k8s)"
run "overlays/prod + jobs" node "$K8S/scripts/check-manifests.mjs" \
  "$OUT/prod.yaml" "$OUT/jobs.yaml" "$VM/namespace-guard.yaml" "$VM/deployer-rbac.yaml"
quiet() { "$@" > /dev/null; }
run "overlays/local + jobs locais" quiet node "$K8S/scripts/check-manifests.mjs" \
  "$OUT/local.yaml" "$OUT/local-jobs.yaml" "$VM/namespace-guard.yaml" "$VM/deployer-rbac.yaml" --local
# O overlay local tem de ser a MESMA lista de objetos da produção (só valores mudam).
objects_of() {  # kind/nome, sem o hash dos ConfigMaps gerados
  # shellcheck disable=SC2016   # o trecho é JavaScript: o $ é do template literal
  node -e '
    const y = require(require("node:module").createRequire(process.argv[1] + "/package.json").resolve("js-yaml"));
    const docs = y.loadAll(require("node:fs").readFileSync(process.argv[2], "utf8")).filter(Boolean);
    console.log(docs.map((o) => `${o.kind}/${o.metadata.name.replace(/-[a-z0-9]{10}$/, "")}`).sort().join("\n"));
  ' "$ROOT" "$1"
}
if diff <(objects_of "$OUT/prod.yaml") <(objects_of "$OUT/local.yaml") >/dev/null; then
  ok "overlay local tem os mesmos objetos da produção"
else
  bad "overlay local tem objetos diferentes da produção: $(diff <(objects_of "$OUT/prod.yaml") <(objects_of "$OUT/local.yaml") | tr '\n' ' ')"
fi

# ------------------------------------------------------------------ 3..5 ferramentas (Docker)
if [[ -n ${SKIP_DOCKER:-} ]]; then
  step "SKIP_DOCKER=1: kubeconform, promtool, loki e alloy pulados"
else
  command -v docker >/dev/null || { echo "Docker é necessário (ou SKIP_DOCKER=1)" >&2; exit 2; }
  PROM_IMAGE=$(image_of prom/prometheus)
  LOKI_IMAGE=$(image_of grafana/loki)
  ALLOY_IMAGE=$(image_of grafana/alloy)

  step "kubeconform (schemas Kubernetes $KUBERNETES_VERSION, modo estrito)"
  for f in prod.yaml local.yaml jobs.yaml; do
    run "$f" docker run --rm -v "$OUT:/m:ro" "$KUBECONFORM_IMAGE" \
      -strict -summary -kubernetes-version "$KUBERNETES_VERSION" \
      -schema-location default \
      -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
      "/m/$f"
  done

  step "Prometheus ($PROM_IMAGE)"
  P=$K8S/observability/prometheus
  mkdir -p "$OUT/prom-secrets" && printf 'x' > "$OUT/prom-secrets/metrics-token" && printf 'x' > "$OUT/prom-secrets/garage-metrics-token"
  run "promtool check config" docker run --rm --entrypoint promtool \
    -v "$P/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
    -v "$P/rules:/etc/prometheus/rules:ro" \
    -v "$OUT/prom-secrets:/etc/prometheus/secrets:ro" \
    "$PROM_IMAGE" check config --syntax-only /etc/prometheus/prometheus.yml
  run "promtool check rules" docker run --rm --entrypoint promtool -v "$P:/p:ro" -w /p \
    "$PROM_IMAGE" check rules rules/fiapx-slo.rules.yml rules/fiapx-alerts.rules.yml
  run "promtool test rules (testes unitários dos alertas e SLOs)" docker run --rm --entrypoint promtool \
    -v "$P:/p:ro" -w /p/tests "$PROM_IMAGE" test rules fiapx-rules.test.yml

  step "Loki ($LOKI_IMAGE)"
  run "loki -verify-config" docker run --rm -v "$K8S/observability/loki/loki.yaml:/etc/loki/loki.yaml:ro" \
    "$LOKI_IMAGE" -config.file=/etc/loki/loki.yaml -target=all -verify-config

  step "Alloy ($ALLOY_IMAGE)"
  A=$K8S/observability/alloy/config.alloy
  run "alloy validate" docker run --rm -e NODE_NAME=node -v "$A:/c/config.alloy:ro" "$ALLOY_IMAGE" validate /c/config.alloy
  if docker run --rm -v "$A:/c/config.alloy:ro" "$ALLOY_IMAGE" fmt /c/config.alloy | diff -q - "$A" >/dev/null; then
    ok "alloy fmt (formatação canônica)"
  else
    bad "config.alloy fora do formato canônico (rode: docker run --rm -v \$PWD:/c $ALLOY_IMAGE fmt /c/config.alloy)"
  fi
fi

# ------------------------------------------------------------------ 6..7 Grafana e nomes do contrato
step "dashboards do Grafana e nomes do contrato (contratos.md, seção 13)"
D=$K8S/observability/grafana/dashboards
check_dashboard() {  # $1 arquivo, $2 uid, $3 título exato
  local f=$D/$1
  jq -e . "$f" >/dev/null || { bad "$1: JSON inválido"; return; }
  [[ $(jq -r .uid "$f") == "$2" ]] || bad "$1: uid != $2"
  [[ $(jq -r .title "$f") == "$3" ]] || bad "$1: título != '$3'"
  local unknown
  unknown=$(jq -r '[.. | objects | select(has("datasource")) | .datasource | objects | .uid] | unique | map(select(. != "prometheus" and . != "loki" and . != "-- Grafana --")) | join(",")' "$f")
  [[ -z $unknown ]] || bad "$1: datasource desconhecido ($unknown)"
  local dup
  dup=$(jq -r '[.panels[].id] | group_by(.) | map(select(length > 1) | .[0]) | join(",")' "$f")
  [[ -z $dup ]] || bad "$1: ids de painel repetidos ($dup)"
  ok "$1 ($(jq '.panels | length' "$f") painéis)"
}
check_dashboard fiapx-pipeline.json fiapx-pipeline 'FIAP X — Pipeline de vídeos'
check_dashboard fiapx-slos.json fiapx-slos 'FIAP X — SLOs'
for alert in FiapxApiErrorRateHigh FiapxUploadLatencyHigh FiapxProcessingSlow FiapxDlqNotEmpty \
             FiapxOutboxBacklog FiapxQueueBacklogHigh FiapxWorkerDown FiapxTargetDown; do
  grep -q "alert: $alert$" "$K8S/observability/prometheus/rules/fiapx-alerts.rules.yml" || bad "alerta $alert ausente"
done
if [[ $(grep -c '^      - alert: ' "$K8S/observability/prometheus/rules/fiapx-alerts.rules.yml") == 8 ]]; then
  ok "8 alertas do contrato"
else
  bad "número de alertas != 8"
fi

# ------------------------------------------------------------------ 8. cópias em sincronia
step "cópias dos arquivos do compose (o kustomize não lê fora da própria pasta)"
run "postgres init = infra/postgres/init" cmp -s "$ROOT/infra/postgres/init/00-create-databases.sh" \
  "$K8S/base/data/postgres/init/00-create-databases.sh"
run "garage.toml = infra/garage/garage.toml" cmp -s "$ROOT/infra/garage/garage.toml" \
  "$K8S/base/data/garage/garage.toml"

# ------------------------------------------------------------------ 9. scripts
step "scripts"
if command -v shellcheck >/dev/null; then
  run "shellcheck" shellcheck -S style "$K8S"/scripts/*.sh
else
  printf '    (shellcheck não instalado: pulado)\n'
fi
for f in "$K8S"/scripts/*.mjs "$K8S"/base/data/*/*.mjs; do
  run "node --check ${f#"$ROOT"/}" node --check "$f"
done

echo
if ((failures > 0)); then
  echo "validate.sh: $failures falha(s)" >&2
  exit 1
fi
echo "validate.sh: tudo OK"
