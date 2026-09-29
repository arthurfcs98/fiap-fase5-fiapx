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
 *   4. cria/atualiza UM USUÁRIO POR SERVIÇO (fiapx-api, fiapx-worker, fiapx-notification), sem
 *      tag (sem acesso ao management) e com o mínimo (art. 46 da LGPD; revisão M3):
 *        configure: só a topologia do contrato (cada serviço a declara ao conectar);
 *        write:     amq.default (cópias de retry), as filas ligadas (bind) e, para api e worker,
 *                   fiapx.events;
 *        read:      fiapx.events/fiapx.dlx (bind) e SÓ as filas que o serviço consome;
 *        topic:     no fiapx.events, cada um só publica as routing keys que são dele (o worker
 *                   não consegue forjar video.completed/user.deleted; o notification não
 *                   publica nada).
 *      O administrador "fiapx" fica só para este Job e para o broker;
 *   5. aplica as operator policies (não mudam argumentos de fila: sem PRECONDITION_FAILED):
 *        "fiapx-limits"      (.*, prioridade 0): max-length-bytes por fila, teto de disco do
 *                            broker (infra/vm/README.md, regra 10). Estourou: vale o x-overflow
 *                            da fila (reject-publish nas filas de trabalho: nack, o outbox e o
 *                            retry tentam de novo);
 *        "fiapx-dlq-limits"  (\.dlq$, prioridade 1, ganha da anterior): o mesmo teto com
 *                            overflow=reject-publish (o padrão drop-head apagaria as mais antigas
 *                            calado; com dead-letter at-least-once a mensagem espera na fila de
 *                            origem) e message-ttl de 7 dias (LGPD: as DLQs guardam e-mail, nome
 *                            e nome do arquivo; o redrive precisa acontecer antes).
 *
 * A TOPOLOGIA (exchanges, filas quorum, retry, DLQ) não é declarada por este script: ela vive
 * em código (libs/messaging/src/topology.ts) e é criada pelo initContainer "topology" do mesmo
 * Job (entry setup-topology.js do video-api, como administrador) ANTES deste script: a topic
 * permission do passo 4 exige o fiapx.events existindo, e os usuários por serviço não conseguem
 * CRIAR fila com dead-letter (o RabbitMQ exige read na fila e write no fiapx.dlx). Os serviços
 * só a redeclaram a cada (re)conexão (para fila existente basta configure). Este script só
 * lista quantas filas existem, para diagnóstico.
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
const DLQ_TTL_MS = positiveInt('RABBITMQ_DLQ_TTL_MS', 7 * 24 * 60 * 60 * 1000);

// Topologia do contrato (libs/messaging/src/topology.ts): 4 filas principais, cada uma com
// .retry.1..3 e .dlq, e as 2 exchanges.
const MAIN_QUEUES = '(worker\\.video-uploaded|api\\.video-processing|api\\.video-deadletter|notification\\.events)';
const TOPOLOGY = `^(fiapx\\.(events|dlx)|${MAIN_QUEUES}(\\.retry\\.[1-3]|\\.dlq)?)$`;
const BIND_TARGETS = `${MAIN_QUEUES}(\\.dlq)?`;
const EXCHANGES_READ = 'fiapx\\.(events|dlx)';

/** Um usuário por serviço, com o mínimo (ver o cabeçalho). */
const SERVICE_USERS = [
  {
    user: 'fiapx-api',
    password: required('API_PASSWORD'),
    publishesEvents: true,
    consumes: 'api\\.video-processing|api\\.video-deadletter',
    routingKeys: '^(video\\.uploaded|video\\.completed|video\\.failed|user\\.deleted)$',
  },
  {
    user: 'fiapx-worker',
    password: required('WORKER_PASSWORD'),
    publishesEvents: true,
    consumes: 'worker\\.video-uploaded',
    routingKeys: '^video\\.processing\\.(started|completed|failed)$',
  },
  {
    user: 'fiapx-notification',
    password: required('NOTIFICATION_PASSWORD'),
    publishesEvents: false,
    consumes: 'notification\\.events',
    routingKeys: '^$',
  },
];
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
  // Sem quebra de linha nem caractere de controle: uma linha de log não forja outra (log injection).
  const safe = Array.from(String(message), (ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : ch;
  }).join('');
  console.log(`[rabbitmq-init] ${safe}`);
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

  for (const service of SERVICE_USERS) {
    const user = encodeURIComponent(service.user);
    await api('PUT', `/api/users/${user}`, { password: service.password, tags: '' });
    await api('PUT', `/api/permissions/${V}/${user}`, {
      configure: TOPOLOGY,
      write: `^(amq\\.default|${service.publishesEvents ? 'fiapx\\.events|' : ''}${BIND_TARGETS})$`,
      read: `^(${EXCHANGES_READ}|${service.consumes})$`,
    });
    await api('PUT', `/api/topic-permissions/${V}/${user}`, {
      exchange: 'fiapx.events',
      write: service.routingKeys,
      read: '.*',
    });
    log(`usuário ${service.user} ok (sem tag; lê só ${service.consumes.replaceAll('\\', '')})`);
  }

  await api('PUT', `/api/operator-policies/${V}/fiapx-limits`, {
    pattern: '.*',
    'apply-to': 'queues',
    priority: 0,
    definition: { 'max-length-bytes': MAX_QUEUE_BYTES },
  });
  log(`operator policy fiapx-limits ok (max-length-bytes=${MAX_QUEUE_BYTES} por fila)`);

  await api('PUT', `/api/operator-policies/${V}/fiapx-dlq-limits`, {
    pattern: '\\.dlq$',
    'apply-to': 'queues',
    priority: 1,
    definition: {
      'max-length-bytes': MAX_QUEUE_BYTES,
      overflow: 'reject-publish',
      'message-ttl': DLQ_TTL_MS,
    },
  });
  log(`operator policy fiapx-dlq-limits ok (reject-publish, message-ttl=${DLQ_TTL_MS} ms)`);

  const queues = await api('GET', `/api/queues/${V}?columns=name`);
  log(`${queues.length} fila(s) no vhost (topologia declarada pelo initContainer "topology")`);
}

main().catch((error) => {
  console.error(`[rabbitmq-init] falhou: ${error.message}`);
  process.exit(1);
});
