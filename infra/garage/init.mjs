#!/usr/bin/env node
/**
 * One-shot idempotente de inicialização do Garage (roda no container `garage-init` do
 * compose, imagem node:22-alpine, sem dependências). Pode rodar quantas vezes quiser:
 *
 *   1. espera a API admin (porta 3903) responder;
 *   2. atribui o layout do nó único (zona dc1) e aplica, se ainda não houver layout;
 *   3. espera o cluster ficar saudável (GET /health = 200);
 *   4. importa a chave S3 local (S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY, geradas no .env por
 *      scripts/dev-secrets.sh), se ainda não existir. Se já existir com OUTRO segredo (o .env
 *      mudou e o volume do Garage não), falha: os apps dariam erro de assinatura S3;
 *   5. cria os buckets (padrão: fiapx-raw e fiapx-zips) e dá leitura/escrita à chave.
 *
 * Usa a Admin API v2 do Garage (https://garagehq.deuxfleurs.fr/api/garage-admin-v2.html).
 * Na E3 esta lógica migra para libs/storage (setup com uma chave por serviço, quotas e
 * lifecycle), mantendo este script como referência dos comandos.
 */

const env = process.env;
const ADMIN_URL = (env.GARAGE_ADMIN_URL ?? 'http://garage:3903').replace(/\/$/, '');
const ADMIN_TOKEN = required('GARAGE_ADMIN_TOKEN');
const KEY_ID = required('S3_ACCESS_KEY_ID');
const KEY_SECRET = required('S3_SECRET_ACCESS_KEY');
const KEY_NAME = env.GARAGE_KEY_NAME ?? 'fiapx-local';
const BUCKETS = (env.GARAGE_BUCKETS ?? 'fiapx-raw,fiapx-zips')
  .split(',')
  .map((b) => b.trim())
  .filter(Boolean);
const ZONE = env.GARAGE_ZONE ?? 'dc1';
const CAPACITY_BYTES = Number(env.GARAGE_CAPACITY_BYTES ?? 10 * 1024 ** 3);
const TIMEOUT_MS = Number(env.GARAGE_INIT_TIMEOUT_MS ?? 90_000);

function required(name) {
  const value = env[name];
  if (!value) {
    console.error(
      `[garage-init] variável obrigatória ausente: ${name} (rode scripts/dev-secrets.sh)`,
    );
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
  console.log(`[garage-init] ${safe}`);
}

class HttpError extends Error {
  constructor(status, body, path) {
    super(`HTTP ${status} em ${path}: ${body}`);
    this.status = status;
  }
}

async function api(method, path, body) {
  const res = await fetch(`${ADMIN_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text.slice(0, 300), path);
  return text ? JSON.parse(text) : undefined;
}

/**
 * GET que devolve `null` só em 404 (a Admin API v2 responde 404 com `NoSuchAccessKey` /
 * `NoSuchBucket`). Qualquer outro erro, inclusive 400, é real e interrompe o init.
 */
async function find(path) {
  try {
    return await api('GET', path);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

async function waitFor(label, probe) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`timeout esperando ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function ensureLayout() {
  const status = await waitFor('API admin do Garage', () => api('GET', '/v2/GetClusterStatus'));
  const node = status.nodes.find((n) => n.isUp) ?? status.nodes[0];
  if (!node) throw new Error('nenhum nó encontrado no cluster');

  const layout = await api('GET', '/v2/GetClusterLayout');
  if (layout.roles.some((role) => role.id === node.id)) {
    log(`layout já aplicado (versão ${layout.version}, nó ${node.id.slice(0, 16)}…)`);
    return;
  }

  log(`atribuindo layout: nó ${node.id.slice(0, 16)}…, zona ${ZONE}, ${CAPACITY_BYTES} bytes`);
  await api('POST', '/v2/UpdateClusterLayout', {
    roles: [{ id: node.id, zone: ZONE, capacity: CAPACITY_BYTES, tags: ['fiapx'] }],
  });
  const staged = await api('GET', '/v2/GetClusterLayout');
  await api('POST', '/v2/ApplyClusterLayout', { version: staged.version + 1 });
  log(`layout aplicado (versão ${staged.version + 1})`);
}

async function waitHealthy() {
  await waitFor('cluster saudável (/health)', async () => {
    const res = await fetch(`${ADMIN_URL}/health`, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  });
  log('cluster saudável');
}

async function ensureKey() {
  const existing = await find(`/v2/GetKeyInfo?id=${encodeURIComponent(KEY_ID)}&showSecretKey=true`);
  if (existing) {
    if (existing.secretAccessKey !== KEY_SECRET) {
      throw new Error(
        `a chave ${KEY_ID} já existe no Garage com OUTRO segredo (S3_SECRET_ACCESS_KEY do .env ` +
          'mudou, mas o volume do Garage não). Restaure o segredo antigo no .env ou recrie o ' +
          'storage local com `make down-v` (apaga os volumes).',
      );
    }
    log(`chave ${KEY_ID} já existe (${existing.name}) e o segredo confere`);
    return;
  }
  await api('POST', '/v2/ImportKey', {
    accessKeyId: KEY_ID,
    secretAccessKey: KEY_SECRET,
    name: KEY_NAME,
  });
  log(`chave ${KEY_ID} importada (${KEY_NAME})`);
}

async function ensureBucket(alias) {
  let bucket = await find(`/v2/GetBucketInfo?globalAlias=${encodeURIComponent(alias)}`);
  if (bucket) {
    log(`bucket ${alias} já existe`);
  } else {
    bucket = await api('POST', '/v2/CreateBucket', { globalAlias: alias });
    log(`bucket ${alias} criado`);
  }
  await api('POST', '/v2/AllowBucketKey', {
    bucketId: bucket.id,
    accessKeyId: KEY_ID,
    permissions: { read: true, write: true, owner: false },
  });
}

async function main() {
  log(`admin API em ${ADMIN_URL}`);
  await ensureLayout();
  await waitHealthy();
  await ensureKey();
  for (const alias of BUCKETS) await ensureBucket(alias);

  const buckets = await api('GET', '/v2/ListBuckets');
  const aliases = buckets.flatMap((b) => b.globalAliases).sort();
  const missing = BUCKETS.filter((b) => !aliases.includes(b));
  if (missing.length > 0) throw new Error(`buckets ausentes após o init: ${missing.join(', ')}`);

  log(`pronto. buckets: ${aliases.join(', ')}`);
  log(`S3 local: endpoint http://localhost:3900, região garage, chave ${KEY_ID} (segredo no .env)`);
}

main().catch((error) => {
  console.error(`[garage-init] falhou: ${error.message}`);
  process.exit(1);
});
