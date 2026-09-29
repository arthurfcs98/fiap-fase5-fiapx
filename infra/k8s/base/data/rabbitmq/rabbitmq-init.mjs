#!/usr/bin/env node
/**
 * Job rabbitmq-init (K8s, fase "setup" do deploy.sh). Idempotente: roda a cada deploy.
 * Usa só a API HTTP de management (15672), sem dependências (Node 22: fetch nativo):
 *
 *   1. espera o broker responder (GET /api/overview) com o usuário administrador "fiapx";
 *   2. confere o vhost "/" (contratos.md, seção 2);
 *   3. cria/atualiza o usuário do KEDA ("fiapx-keda", tag "monitoring") com a senha do
 *      Secret fiapx-keda-rabbitmq e permissões VAZIAS (^$) no vhost: ele só lê o tamanho das
 *      filas pela API de management, nunca publica nem consome;
 *   4. aplica a operator policy "fiapx-limits" (max-length-bytes por fila): teto de disco do
 *      broker (infra/vm/README.md, regra 10). Operator policy não muda os argumentos das
 *      filas, então não gera PRECONDITION_FAILED com a topologia declarada pelos serviços.
 *      Estourou o teto: vale o x-overflow da fila (reject-publish nas filas de trabalho: o
 *      publisher recebe nack e o outbox tenta de novo).
 *
 * A TOPOLOGIA (exchanges, filas quorum, retry, DLQ) não é declarada aqui: ela vive em código
 * (libs/messaging/src/topology.ts) e cada serviço a declara a cada (re)conexão. Este Job só
 * lista quantas filas já existem, para diagnóstico.
 *
 * Nunca imprime senha.
 */

const env = process.env;
const BASE_URL = (env.RABBITMQ_MANAGEMENT_URL ?? 'http://rabbitmq:15672').replace(/\/$/, '');
const ADMIN_USER = env.RABBITMQ_ADMIN_USER ?? 'fiapx';
const ADMIN_PASSWORD = required('RABBITMQ_ADMIN_PASSWORD');
const KEDA_USER = env.KEDA_USER ?? 'fiapx-keda';
const KEDA_PASSWORD = required('KEDA_PASSWORD');
const VHOST = env.RABBITMQ_VHOST ?? '/';
const MAX_QUEUE_BYTES = positiveInt('RABBITMQ_MAX_QUEUE_BYTES', 64 * 1024 ** 2);
const TIMEOUT_MS = positiveInt('RABBITMQ_INIT_TIMEOUT_MS', 120_000);
const AUTH = `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString('base64')}`;
const V = encodeURIComponent(VHOST);

function required(name) {
  const value = env[name];
  if (!value) {
    console.error(`[rabbitmq-init] variável obrigatória ausente: ${name}`);
    process.exit(2);
  }
  return value;
}

function positiveInt(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`[rabbitmq-init] ${name} precisa ser um inteiro positivo (recebido: ${raw})`);
    process.exit(2);
  }
  return value;
}

function log(message) {
  console.log(`[rabbitmq-init] ${message}`);
}

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      authorization: AUTH,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${method} ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

async function waitForBroker() {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const overview = await api('GET', '/api/overview');
      log(`broker ${overview.rabbitmq_version} no nó ${overview.node}`);
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`timeout esperando a API de management: ${lastError?.message ?? '?'}`);
}

async function main() {
  log(`API de management em ${BASE_URL}`);
  await waitForBroker();

  await api('GET', `/api/vhosts/${V}`);
  log(`vhost "${VHOST}" ok`);

  await api('PUT', `/api/users/${encodeURIComponent(KEDA_USER)}`, {
    password: KEDA_PASSWORD,
    tags: 'monitoring',
  });
  await api('PUT', `/api/permissions/${V}/${encodeURIComponent(KEDA_USER)}`, {
    configure: '^$',
    write: '^$',
    read: '^$',
  });
  log(`usuário ${KEDA_USER} ok (tag monitoring, sem permissão de mensagens)`);

  await api('PUT', `/api/operator-policies/${V}/fiapx-limits`, {
    pattern: '.*',
    'apply-to': 'queues',
    priority: 0,
    definition: { 'max-length-bytes': MAX_QUEUE_BYTES },
  });
  log(`operator policy fiapx-limits ok (max-length-bytes=${MAX_QUEUE_BYTES} por fila)`);

  const queues = await api('GET', `/api/queues/${V}?columns=name`);
  log(
    `${queues.length} fila(s) no vhost (a topologia é declarada pelos serviços ao conectar; ` +
      'no primeiro deploy pode ser 0)',
  );
}

main().catch((error) => {
  console.error(`[rabbitmq-init] falhou: ${error.message}`);
  process.exit(1);
});
