#!/usr/bin/env node
/**
 * Confere os manifestos RENDERIZADOS contra as regras do SRE (infra/vm/README.md, seção 6.6)
 * e contra o orçamento do namespace (infra/vm/k8s/namespace-guard.yaml), SEM cluster.
 *
 *   node infra/k8s/scripts/check-manifests.mjs <overlay.yaml> <jobs.yaml> \
 *     infra/vm/k8s/namespace-guard.yaml infra/vm/k8s/deployer-rbac.yaml
 *
 * Os limites (quota, LimitRange, PriorityClasses) e os kinds permitidos (Role do CD) são lidos
 * dos arquivos do SRE: se eles mudarem, a conferência acompanha.
 * Chamado pelo scripts/validate.sh. Sai com 1 se alguma regra falhar. Usa o js-yaml que já
 * está no node_modules do monorepo (dependência do @nestjs/swagger); nada novo instalado.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, '../../../package.json'));
let yaml;
try {
  yaml = require('js-yaml');
} catch {
  console.error('check-manifests: js-yaml não encontrado. Rode "npm ci" na raiz do repositório.');
  process.exit(2);
}

// --local: overlay do k3d, onde os apps usam a tag "local" (build do compose).
const LOCAL = process.argv.includes('--local');
const [overlayPath, jobsPath, guardPath, rbacPath] = process.argv.slice(2).filter((a) => a !== '--local');
if (!overlayPath || !jobsPath || !guardPath || !rbacPath) {
  console.error('uso: check-manifests.mjs <overlay.yaml> <jobs.yaml> <namespace-guard.yaml> <deployer-rbac.yaml>');
  process.exit(2);
}

const load = (path) => yaml.loadAll(readFileSync(path, 'utf8')).filter(Boolean);
const objects = load(overlayPath);
const jobs = load(jobsPath);
const guard = load(guardPath);
const deployerRbac = load(rbacPath);

const failures = [];
const fail = (msg) => failures.push(msg);
const id = (o) => `${o.kind}/${o.metadata?.name}`;

// ------------------------------------------------------------------ quantidades
function cpu(q) {
  if (q === undefined) return undefined;
  const s = String(q);
  return s.endsWith('m') ? Number(s.slice(0, -1)) : Number(s) * 1000; // millicores
}
const UNITS = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, k: 1e3, M: 1e6, G: 1e9, T: 1e12 };
function bytes(q) {
  if (q === undefined) return undefined;
  const m = /^([0-9.]+)([A-Za-z]*)$/.exec(String(q));
  if (!m) throw new Error(`quantidade inválida: ${q}`);
  return Number(m[1]) * (m[2] ? UNITS[m[2]] : 1);
}
const mi = (b) => `${Math.round(b / 2 ** 20)}Mi`;

// ------------------------------------------------------------------ regras do namespace
const quota = guard.find((o) => o.kind === 'ResourceQuota' && o.metadata.name === 'fiapx-teto');
const limitRange = guard.find((o) => o.kind === 'LimitRange');
const priorityClasses = guard.filter((o) => o.kind === 'PriorityClass').map((o) => o.metadata.name);
if (!quota || !limitRange) {
  console.error('check-manifests: namespace-guard.yaml sem ResourceQuota fiapx-teto ou LimitRange');
  process.exit(2);
}
const hard = quota.spec.hard;
const containerLimits = limitRange.spec.limits.find((l) => l.type === 'Container');
const pvcLimits = limitRange.spec.limits.find((l) => l.type === 'PersistentVolumeClaim');

// Kinds que a Role fiapx-deployer pode criar/atualizar (infra/vm/k8s/deployer-rbac.yaml).
const RESOURCE_KIND = {
  configmaps: 'ConfigMap', services: 'Service', serviceaccounts: 'ServiceAccount',
  persistentvolumeclaims: 'PersistentVolumeClaim', deployments: 'Deployment',
  statefulsets: 'StatefulSet', daemonsets: 'DaemonSet', jobs: 'Job', cronjobs: 'CronJob',
  ingresses: 'Ingress', horizontalpodautoscalers: 'HorizontalPodAutoscaler',
  poddisruptionbudgets: 'PodDisruptionBudget', scaledobjects: 'ScaledObject',
  triggerauthentications: 'TriggerAuthentication', middlewares: 'Middleware',
};
const deployerRole = deployerRbac.find((o) => o.kind === 'Role' && o.metadata.name === 'fiapx-deployer');
if (!deployerRole) {
  console.error('check-manifests: deployer-rbac.yaml sem a Role fiapx-deployer');
  process.exit(2);
}
const ALLOWED_KINDS = new Set(
  deployerRole.rules
    .filter((r) => r.verbs.includes('create') && r.verbs.includes('patch'))
    .flatMap((r) => r.resources)
    .map((r) => RESOURCE_KIND[r])
    .filter(Boolean),
);
const APP_IMAGE = LOCAL
  ? /^ghcr\.io\/arthurfcs98\/fiapx-(video-api|video-worker|notification-service):local$/
  : /^ghcr\.io\/arthurfcs98\/fiapx-(video-api|video-worker|notification-service)$/;
const FIXED_NAME_CONFIGMAPS = new Set(['fiapx-garage-init', 'fiapx-rabbitmq-init']);

function podSpecOf(o) {
  if (['Deployment', 'StatefulSet', 'DaemonSet', 'Job'].includes(o.kind)) {
    return o.spec.template.spec;
  }
  if (o.kind === 'CronJob') return o.spec.jobTemplate.spec.template.spec;
  return undefined;
}

function checkPod(owner, spec) {
  const name = id(owner);
  if (spec.priorityClassName && !priorityClasses.includes(spec.priorityClassName)) {
    fail(`${name}: priorityClassName ${spec.priorityClassName} fora das classes fiapx-*`);
  }
  if (!spec.priorityClassName) fail(`${name}: sem priorityClassName`);
  if (spec.hostNetwork || spec.hostPID || spec.hostIPC) fail(`${name}: usa namespaces do host`);
  for (const v of spec.volumes ?? []) {
    if (v.hostPath) fail(`${name}: volume hostPath ${v.name} (proibido pelo PSA baseline)`);
  }
  const psc = spec.securityContext ?? {};
  if (psc.runAsNonRoot !== true) fail(`${name}: pod sem runAsNonRoot: true`);
  if (psc.seccompProfile?.type !== 'RuntimeDefault') fail(`${name}: seccompProfile != RuntimeDefault`);
  for (const c of [...(spec.initContainers ?? []), ...spec.containers]) {
    const cname = `${name}[${c.name}]`;
    const sc = c.securityContext ?? {};
    if (sc.privileged) fail(`${cname}: privileged`);
    if (sc.allowPrivilegeEscalation !== false) fail(`${cname}: allowPrivilegeEscalation != false`);
    if (!(sc.capabilities?.drop ?? []).includes('ALL')) fail(`${cname}: não descarta ALL capabilities`);
    if (sc.readOnlyRootFilesystem !== true) fail(`${cname}: readOnlyRootFilesystem != true`);
    for (const p of c.ports ?? []) if (p.hostPort) fail(`${cname}: hostPort ${p.hostPort}`);

    const image = c.image ?? '';
    const bare = image.split('@')[0];
    if (bare.startsWith('ghcr.io/arthurfcs98/')) {
      if (!APP_IMAGE.test(bare)) fail(`${cname}: imagem do projeto com tag ou nome inesperado (${image})`);
    } else if (!/@sha256:[0-9a-f]{64}$/.test(image) || !/:[^/@]+@/.test(image)) {
      fail(`${cname}: imagem de infra sem tag + digest (${image})`);
    }

    const req = c.resources?.requests ?? {};
    const lim = c.resources?.limits ?? {};
    for (const [k, v] of [['requests.cpu', req.cpu], ['requests.memory', req.memory], ['limits.cpu', lim.cpu], ['limits.memory', lim.memory]]) {
      if (v === undefined) fail(`${cname}: sem ${k}`);
    }
    if (req.memory && lim.memory && !(bytes(req.memory) < bytes(lim.memory))) {
      fail(`${cname}: request de memória precisa ser MENOR que o limit (política fiapx-sem-guaranteed)`);
    }
    if (lim.cpu && cpu(lim.cpu) > cpu(containerLimits.max.cpu)) fail(`${cname}: CPU acima do máximo do LimitRange`);
    if (lim.memory && bytes(lim.memory) > bytes(containerLimits.max.memory)) {
      fail(`${cname}: memória acima do máximo do LimitRange`);
    }
    if (req.memory && lim.memory && bytes(lim.memory) / bytes(req.memory) > Number(containerLimits.maxLimitRequestRatio.memory)) {
      fail(`${cname}: limit/request de memória acima de ${containerLimits.maxLimitRequestRatio.memory}`);
    }
    if (req.cpu && lim.cpu && cpu(lim.cpu) / cpu(req.cpu) > Number(containerLimits.maxLimitRequestRatio.cpu)) {
      fail(`${cname}: limit/request de CPU acima de ${containerLimits.maxLimitRequestRatio.cpu}`);
    }
  }
}

/** Recursos efetivos de um pod (LimitRange preenche o que faltar). */
function podResources(spec) {
  const d = containerLimits;
  const sum = { cpuReq: 0, cpuLim: 0, memReq: 0, memLim: 0, ephReq: 0, ephLim: 0 };
  for (const c of spec.containers) {
    const req = c.resources?.requests ?? {};
    const lim = c.resources?.limits ?? {};
    sum.cpuReq += cpu(req.cpu ?? d.defaultRequest.cpu);
    sum.cpuLim += cpu(lim.cpu ?? d.default.cpu);
    sum.memReq += bytes(req.memory ?? d.defaultRequest.memory);
    sum.memLim += bytes(lim.memory ?? d.default.memory);
    sum.ephReq += bytes(req['ephemeral-storage'] ?? d.defaultRequest['ephemeral-storage']);
    sum.ephLim += bytes(lim['ephemeral-storage'] ?? d.default['ephemeral-storage']);
  }
  return sum;
}

// ------------------------------------------------------------------ objetos do overlay
const byKindName = new Map(objects.map((o) => [id(o), o]));
const scaled = new Map(); // Deployment -> { min, max }
for (const o of objects) {
  if (o.kind === 'HorizontalPodAutoscaler') {
    scaled.set(o.spec.scaleTargetRef.name, { min: o.spec.minReplicas ?? 1, max: o.spec.maxReplicas, by: 'HPA' });
  }
  if (o.kind === 'ScaledObject') {
    scaled.set(o.spec.scaleTargetRef.name, { min: o.spec.minReplicaCount ?? 0, max: o.spec.maxReplicaCount ?? 100, by: 'KEDA' });
  }
}

let pvcCount = 0;
let pvcBytes = 0;
for (const o of objects) {
  const name = id(o);
  if (!ALLOWED_KINDS.has(o.kind)) fail(`${name}: kind fora do que o CD pode aplicar (deployer-rbac.yaml)`);
  if (o.metadata?.labels?.['app.kubernetes.io/part-of'] !== 'fiapx') fail(`${name}: sem app.kubernetes.io/part-of=fiapx`);
  if (o.metadata?.namespace && o.metadata.namespace !== 'fiapx') fail(`${name}: namespace ${o.metadata.namespace}`);
  if (o.kind === 'Service' && (o.spec.type ?? 'ClusterIP') !== 'ClusterIP') fail(`${name}: Service ${o.spec.type} (quota: nodeports/loadbalancers = 0)`);
  if (o.kind === 'Ingress' && o.metadata.name !== 'video-api') fail(`${name}: só o video-api é público`);
  if (o.kind === 'Ingress' && o.spec.ingressClassName !== 'traefik') fail(`${name}: ingressClassName != traefik`);
  if (o.kind === 'ConfigMap' && !FIXED_NAME_CONFIGMAPS.has(o.metadata.name) && !/-[a-z0-9]{10}$/.test(o.metadata.name)) {
    fail(`${name}: ConfigMap fora do configMapGenerator (regra 8 do deploy.sh)`);
  }
  if (o.kind === 'PersistentVolumeClaim') {
    pvcCount += 1;
    pvcBytes += bytes(o.spec.resources.requests.storage);
    if (bytes(o.spec.resources.requests.storage) > bytes(pvcLimits.max.storage)) fail(`${name}: PVC acima de ${pvcLimits.max.storage}`);
  }
  if (o.kind === 'StatefulSet') {
    if (o.metadata.labels?.['fiapx.io/tier'] !== 'data') fail(`${name}: StatefulSet sem fiapx.io/tier=data`);
    for (const t of o.spec.volumeClaimTemplates ?? []) {
      pvcCount += o.spec.replicas ?? 1;
      pvcBytes += bytes(t.spec.resources.requests.storage) * (o.spec.replicas ?? 1);
      if (t.metadata.labels?.['fiapx.io/tier'] !== 'data') fail(`${name}: volumeClaimTemplate sem fiapx.io/tier=data`);
      if (bytes(t.spec.resources.requests.storage) > bytes(pvcLimits.max.storage)) fail(`${name}: PVC acima de ${pvcLimits.max.storage}`);
    }
    // ConfigMaps/Secrets do STS de dados precisam existir na fase de dados.
    for (const v of o.spec.template.spec.volumes ?? []) {
      const cm = v.configMap?.name;
      if (cm && byKindName.get(`ConfigMap/${cm}`)?.metadata.labels?.['fiapx.io/tier'] !== 'data') {
        fail(`${name}: ConfigMap ${cm} usado pela camada de dados sem fiapx.io/tier=data`);
      }
    }
  }
  if (o.kind === 'Deployment') {
    const s = scaled.get(o.metadata.name);
    if (s && o.spec.replicas !== undefined) fail(`${name}: tem "replicas" mas é escalado por ${s.by} (regra 4)`);
    const grace = o.spec.template.spec.terminationGracePeriodSeconds ?? 30;
    if ((o.spec.progressDeadlineSeconds ?? 600) <= grace) fail(`${name}: progressDeadlineSeconds <= grace`);
  }
  const spec = podSpecOf(o);
  if (spec) checkPod(o, spec);
}

const api = byKindName.get('Deployment/video-api');
const worker = byKindName.get('Deployment/video-worker');
const notification = byKindName.get('Deployment/notification-service');
if (api?.spec.progressDeadlineSeconds !== 180) fail('Deployment/video-api: progressDeadlineSeconds != 180 (regra 5)');
if (notification?.spec.progressDeadlineSeconds !== 180) fail('Deployment/notification-service: progressDeadlineSeconds != 180 (regra 5)');
if (worker?.spec.progressDeadlineSeconds !== 480) fail('Deployment/video-worker: progressDeadlineSeconds != 480 (regra 5)');
if ((worker?.spec.template.spec.terminationGracePeriodSeconds ?? 0) < 330) fail('Deployment/video-worker: terminationGracePeriodSeconds < 330');
if (worker?.spec.strategy?.type !== 'Recreate') fail('Deployment/video-worker: estratégia != Recreate (D5)');
if (notification?.spec.strategy?.type !== 'Recreate') fail('Deployment/notification-service: estratégia != Recreate (D5)');

for (const app of ['video-api', 'video-worker', 'notification-service']) {
  const seen = objects.some((o) => (podSpecOf(o)?.containers ?? []).some((c) => c.image?.split('@')[0].split(':')[0] === `ghcr.io/arthurfcs98/fiapx-${app}`));
  if (!seen) fail(`o overlay não usa ghcr.io/arthurfcs98/fiapx-${app} (o deploy.sh recusaria)`);
}

// ------------------------------------------------------------------ Jobs
for (const j of jobs) {
  const name = id(j);
  if (j.kind !== 'Job') { fail(`${name}: só Jobs em infra/k8s/jobs`); continue; }
  const phase = j.metadata.labels?.['fiapx.io/phase'];
  if (!['backup', 'setup', 'migrate'].includes(phase)) fail(`${name}: fiapx.io/phase inválido (${phase})`);
  if (j.metadata.labels?.['app.kubernetes.io/part-of'] !== 'fiapx') fail(`${name}: sem part-of=fiapx`);
  if (j.spec.backoffLimit !== 0) fail(`${name}: backoffLimit != 0`);
  if (!(j.spec.activeDeadlineSeconds < 300)) fail(`${name}: activeDeadlineSeconds precisa ser < 300`);
  if (!j.spec.ttlSecondsAfterFinished) fail(`${name}: sem ttlSecondsAfterFinished`);
  checkPod(j, j.spec.template.spec);
  for (const v of j.spec.template.spec.volumes ?? []) {
    const cm = v.configMap?.name;
    if (cm && byKindName.get(`ConfigMap/${cm}`)?.metadata.labels?.['fiapx.io/tier'] !== 'data') {
      fail(`${name}: ConfigMap ${cm} precisa estar na camada de dados (existe antes dos Jobs)`);
    }
  }
}

// ------------------------------------------------------------------ orçamento (quota)
function scenario(label, pick, surge) {
  const total = { cpuReq: 0, cpuLim: 0, memReq: 0, memLim: 0, ephReq: 0, ephLim: 0, pods: 0 };
  for (const o of objects) {
    if (!['Deployment', 'StatefulSet', 'DaemonSet'].includes(o.kind)) continue;
    const s = scaled.get(o.metadata.name);
    // DaemonSet: um pod por nó; a VM tem um nó só.
    let replicas = o.kind === 'DaemonSet' ? 1 : s ? pick(s) : (o.spec.replicas ?? 1);
    if (surge && o.kind === 'Deployment' && o.spec.strategy?.type !== 'Recreate') {
      replicas += Number(o.spec.strategy?.rollingUpdate?.maxSurge ?? 1);
    }
    const r = podResources(podSpecOf(o));
    for (const k of Object.keys(r)) total[k] += r[k] * replicas;
    total.pods += replicas;
  }
  return { label, ...total };
}

const scenarios = [
  scenario('regime (réplicas mínimas)', (s) => s.min, false),
  scenario('escala máxima', (s) => s.max, false),
  scenario('escala máxima + surge do deploy', (s) => s.max, true),
];
const jobPeak = jobs.reduce((max, j) => {
  const r = podResources(j.spec.template.spec);
  return r.memLim > max.memLim ? r : max;
}, { cpuReq: 0, cpuLim: 0, memReq: 0, memLim: 0, ephReq: 0, ephLim: 0 });

const cap = {
  cpuReq: cpu(hard['requests.cpu']), cpuLim: cpu(hard['limits.cpu']),
  memReq: bytes(hard['requests.memory']), memLim: bytes(hard['limits.memory']),
  ephReq: bytes(hard['requests.ephemeral-storage']), ephLim: bytes(hard['limits.ephemeral-storage']),
  pods: Number(hard.pods),
};

console.log('Orçamento do namespace fiapx (ResourceQuota fiapx-teto):');
console.log('  cenário                              CPU req   CPU lim   mem req   mem lim   eph req   eph lim  pods');
const fmtRow = (r) => `  ${r.label.padEnd(36)} ${`${r.cpuReq}m`.padStart(7)} ${`${r.cpuLim}m`.padStart(9)} ${mi(r.memReq).padStart(9)} ${mi(r.memLim).padStart(9)} ${mi(r.ephReq).padStart(9)} ${mi(r.ephLim).padStart(9)} ${String(r.pods).padStart(5)}`;
for (const s of scenarios) console.log(fmtRow(s));
console.log(fmtRow({ label: 'quota', ...cap }));
for (const s of scenarios) {
  for (const k of Object.keys(cap)) {
    if (s[k] > cap[k]) fail(`orçamento: ${s.label} passa da quota em ${k}`);
  }
}
// Deploy normal: Jobs rodam com as réplicas em regime (antes do rollout dos apps).
const regimeWithJob = { ...scenarios[0] };
for (const k of Object.keys(jobPeak)) regimeWithJob[k] += jobPeak[k];
regimeWithJob.pods += 1;
regimeWithJob.label = 'regime + 1 Job (deploy)';
console.log(fmtRow(regimeWithJob));
for (const k of Object.keys(cap)) {
  if (regimeWithJob[k] > cap[k]) fail(`orçamento: regime + Job passa da quota em ${k}`);
}

console.log(`\nVolumes: ${pvcCount} PVC(s), ${mi(pvcBytes)} (quota: ${hard.persistentvolumeclaims} PVCs, ${hard['requests.storage']})`);
if (pvcCount > Number(hard.persistentvolumeclaims)) fail('orçamento: PVCs acima da quota');
if (pvcBytes > bytes(hard['requests.storage'])) fail('orçamento: requests.storage acima da quota');

if (failures.length > 0) {
  console.error(`\n${failures.length} problema(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nOK: ${objects.length} objetos + ${jobs.length} Jobs seguem as regras do deploy.sh e cabem na quota.`);
