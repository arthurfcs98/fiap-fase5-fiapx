#!/usr/bin/env node
/**
 * Job garage-init (K8s, fase "setup" do deploy.sh). Idempotente: roda a cada deploy.
 *
 * Versão do cluster de infra/garage/init.mjs (compose), com MENOR PRIVILÉGIO:
 *   1. espera a API admin (3903) e aplica o layout do nó único, se ainda não houver;
 *   2. espera o cluster ficar saudável (GET /health = 200);
 *   3. importa DUAS chaves S3 (geradas pelo scripts/bootstrap-secrets.sh, lidas do Secret
 *      fiapx-garage): svc-api e svc-worker. Chave existente com OUTRO segredo = erro (os apps
 *      falhariam com erro de assinatura S3);
 *   4. cria os buckets e aplica as permissões por chave (Allow no que é preciso, Deny no resto):
 *        svc-api:    fiapx-raw leitura+escrita, fiapx-zips leitura+escrita (a retenção LGPD e a
 *                    eliminação de conta apagam objetos nos dois buckets);
 *        svc-worker: fiapx-raw só leitura,      fiapx-zips leitura+escrita;
 *   5. aplica as quotas de tamanho por bucket (teto de disco do app: infra/vm/README.md, D11).
 *
 * Nunca imprime segredo: só IDs de chave e nomes de bucket.
 * Sem dependências (Node 22: fetch nativo). Admin API v2:
 * https://garagehq.deuxfleurs.fr/api/garage-admin-v2.html
 */

const env = process.env;
const ADMIN_URL = (env.GARAGE_ADMIN_URL ?? 'http://garage:3903').replace(/\/$/, '');
const ADMIN_TOKEN = required('GARAGE_ADMIN_TOKEN');
const RAW = env.S3_BUCKET_RAW ?? 'fiapx-raw';
const ZIPS = env.S3_BUCKET_ZIPS ?? 'fiapx-zips';
const ZONE = env.GARAGE_ZONE ?? 'dc1';
const CAPACITY_BYTES = positiveInt('GARAGE_CAPACITY_BYTES', 4 * 1024 ** 3);
const TIMEOUT_MS = positiveInt('GARAGE_INIT_TIMEOUT_MS', 120_000);

const QUOTAS = {
  [RAW]: positiveInt('GARAGE_QUOTA_RAW_BYTES', 1 * 1024 ** 3),
  [ZIPS]: positiveInt('GARAGE_QUOTA_ZIPS_BYTES', Math.round(2.5 * 1024 ** 3)),
};

const KEYS = [
  {
    name: 'svc-api',
    id: required('API_ACCESS_KEY_ID'),
    secret: required('API_SECRET_ACCESS_KEY'),
    permissions: {
      [RAW]: { read: true, write: true, owner: false },
      [ZIPS]: { read: true, write: true, owner: false },
    },
  },
  {
    name: 'svc-worker',
    id: required('WORKER_ACCESS_KEY_ID'),
    secret: required('WORKER_SECRET_ACCESS_KEY'),
    permissions: {
      [RAW]: { read: true, write: false, owner: false },
      [ZIPS]: { read: true, write: true, owner: false },
    },
  },
];

function required(name) {
  const value = env[name];
  if (!value) {
    console.error(`[garage-init] variável obrigatória ausente: ${name} (Secret fiapx-garage)`);
    process.exit(2);
  }
  return value;
}

function positiveInt(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`[garage-init] ${name} precisa ser um inteiro positivo (recebido: ${raw})`);
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
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  // O corpo de erro da API admin nunca contém o segredo de uma chave (só no GetKeyInfo com
  // showSecretKey, que só é lido em caso de sucesso e nunca impresso).
  if (!res.ok) throw new HttpError(res.status, text.slice(0, 300), path.split('?')[0]);
  return text ? JSON.parse(text) : undefined;
}

/** GET que devolve `null` só em 404 (chave/bucket inexistente); outros erros propagam. */
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

async function ensureKey(key) {
  const existing = await find(
    `/v2/GetKeyInfo?id=${encodeURIComponent(key.id)}&showSecretKey=true`,
  );
  if (existing) {
    if (existing.secretAccessKey !== key.secret) {
      throw new Error(
        `a chave ${key.name} (${key.id}) já existe no Garage com OUTRO segredo. O Secret ` +
          'fiapx-garage mudou e o volume do Garage não: restaure o segredo antigo ou ' +
          'importe de novo (ver infra/k8s/README.md, "Rotação de segredos").',
      );
    }
    log(`chave ${key.name} (${key.id}) já existe e o segredo confere`);
    return;
  }
  await api('POST', '/v2/ImportKey', {
    accessKeyId: key.id,
    secretAccessKey: key.secret,
    name: key.name,
  });
  log(`chave ${key.name} (${key.id}) importada`);
}

async function ensureBucket(alias) {
  let bucket = await find(`/v2/GetBucketInfo?globalAlias=${encodeURIComponent(alias)}`);
  if (bucket) {
    log(`bucket ${alias} já existe`);
  } else {
    bucket = await api('POST', '/v2/CreateBucket', { globalAlias: alias });
    log(`bucket ${alias} criado`);
  }
  return bucket;
}

async function applyPermissions(bucket, alias) {
  for (const key of KEYS) {
    const wanted = key.permissions[alias];
    // Allow só liga (true) e Deny só desliga (true = revogar): as duas chamadas juntas deixam
    // exatamente o desejado, inclusive tirando uma permissão dada por uma versão anterior.
    const deny = Object.fromEntries(Object.entries(wanted).map(([p, on]) => [p, !on]));
    await api('POST', '/v2/AllowBucketKey', {
      bucketId: bucket.id,
      accessKeyId: key.id,
      permissions: wanted,
    });
    await api('POST', '/v2/DenyBucketKey', {
      bucketId: bucket.id,
      accessKeyId: key.id,
      permissions: deny,
    });
    const granted = Object.entries(wanted)
      .filter(([, on]) => on)
      .map(([p]) => p)
      .join('+');
    log(`permissões: ${key.name} em ${alias} = ${granted || 'nenhuma'}`);
  }
}

async function applyQuota(bucket, alias) {
  const maxSize = QUOTAS[alias];
  await api('POST', `/v2/UpdateBucket?id=${encodeURIComponent(bucket.id)}`, {
    quotas: { maxSize, maxObjects: null },
  });
  log(`quota de ${alias}: ${maxSize} bytes`);
}

async function main() {
  log(`admin API em ${ADMIN_URL}`);
  await ensureLayout();
  await waitHealthy();
  for (const key of KEYS) await ensureKey(key);
  for (const alias of [RAW, ZIPS]) {
    const bucket = await ensureBucket(alias);
    await applyPermissions(bucket, alias);
    await applyQuota(bucket, alias);
  }

  const buckets = await api('GET', '/v2/ListBuckets');
  const aliases = buckets.flatMap((b) => b.globalAliases).sort();
  const missing = [RAW, ZIPS].filter((b) => !aliases.includes(b));
  if (missing.length > 0) throw new Error(`buckets ausentes após o init: ${missing.join(', ')}`);
  log(`pronto. buckets: ${aliases.join(', ')}`);
}

main().catch((error) => {
  console.error(`[garage-init] falhou: ${error.message}`);
  process.exit(1);
});
