/* global XMLHttpRequest */
/*
 * HTTP client for the video-api (contratos.md, sections 8 and 12).
 *
 * Every error becomes an ApiError built from the API error envelope
 * `{ statusCode, error: { message, code, description, metadata }, correlationId }`.
 * A 401 on an authenticated call notifies the session handler (token expired or revoked).
 */
import { parseRetryAfter } from './format.js';

export const API_BASE = '/api';

/**
 * Statuses retried automatically for uploads, always with the same Idempotency-Key
 * (PLANO-EXECUCAO: only 429 and 503; 400/413 are never retried, the UI shows the reason).
 */
const RETRYABLE_STATUSES = new Set([429, 503]);

const FALLBACK_DESCRIPTIONS = {
  0: 'Não foi possível falar com o servidor. Verifique sua conexão.',
  400: 'Requisição inválida.',
  401: 'Sua sessão expirou. Entre novamente.',
  403: 'Acesso negado.',
  404: 'Recurso não encontrado.',
  409: 'A operação conflita com o estado atual.',
  410: 'O recurso expirou e não está mais disponível.',
  413: 'O arquivo excede o tamanho máximo permitido.',
  429: 'Muitas requisições. Aguarde alguns instantes e tente de novo.',
  500: 'Erro interno no servidor.',
  502: 'O serviço está temporariamente indisponível.',
  503: 'O serviço está temporariamente indisponível.',
  504: 'O servidor demorou para responder.',
};

export class ApiError extends Error {
  constructor({
    status,
    code = null,
    errorName = null,
    description,
    metadata = {},
    correlationId = null,
    retryAfterSeconds = null,
  }) {
    super(description);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.errorName = errorName;
    this.description = description;
    this.metadata = metadata;
    this.correlationId = correlationId;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  get isNetworkError() {
    return this.status === 0;
  }

  get isRetryable() {
    return RETRYABLE_STATUSES.has(this.status);
  }
}

export function isAbortError(error) {
  return Boolean(error) && error.name === 'AbortError';
}

function fallbackDescription(status) {
  if (Object.hasOwn(FALLBACK_DESCRIPTIONS, status)) return FALLBACK_DESCRIPTIONS[status];
  return status >= 500 ? `Erro no servidor (HTTP ${status}).` : `Erro inesperado (HTTP ${status}).`;
}

/** Field names of the API payloads shown with their pt-BR form labels. */
const FIELD_LABELS = {
  name: 'Nome',
  email: 'E-mail',
  password: 'Senha',
  acceptPrivacyPolicy: 'Política de Privacidade',
};

/** One X0001 issue (`{ field, message }` from ZodValidationPipe) as "Campo: mensagem". */
function describeField(field) {
  if (typeof field === 'string') return field;
  if (field && typeof field === 'object') {
    const raw = Array.isArray(field.path)
      ? field.path.join('.')
      : field.field || field.path || field.property;
    const path = raw && raw !== '(raiz)' ? String(raw) : '';
    const label = Object.hasOwn(FIELD_LABELS, path) ? FIELD_LABELS[path] : path;
    const message = typeof field.message === 'string' ? field.message : '';
    if (label && message) return `${label}: ${message}`;
    return message || label;
  }
  return '';
}

function safeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Builds an ApiError from a non-2xx response (body may be the error envelope, HTML or empty). */
export function errorFromResponse({
  status,
  bodyText,
  retryAfter = null,
  correlationId = null,
  now = Date.now(),
}) {
  const body = safeJson(bodyText);
  const envelope =
    body && typeof body === 'object' && body.error && typeof body.error === 'object'
      ? body.error
      : null;
  const metadata =
    envelope && envelope.metadata && typeof envelope.metadata === 'object' ? envelope.metadata : {};
  const code = typeof envelope?.code === 'string' && envelope.code ? envelope.code : null;

  let description =
    typeof envelope?.description === 'string' && envelope.description.trim()
      ? envelope.description.trim()
      : fallbackDescription(status);

  if (code === 'X0001' && Array.isArray(metadata.fields)) {
    const details = metadata.fields.map(describeField).filter(Boolean).slice(0, 3);
    if (details.length > 0) description = `${description} ${details.join('; ')}`;
  }

  const headerSeconds = parseRetryAfter(retryAfter, now);
  const metaSeconds = Number.isFinite(metadata.retryAfterSeconds)
    ? metadata.retryAfterSeconds
    : null;

  return new ApiError({
    status,
    code,
    errorName: typeof envelope?.message === 'string' ? envelope.message : null,
    description,
    metadata,
    correlationId:
      (typeof body?.correlationId === 'string' && body.correlationId) || correlationId || null,
    retryAfterSeconds: headerSeconds ?? metaSeconds,
  });
}

export function networkError() {
  return new ApiError({ status: 0, description: fallbackDescription(0) });
}

/** Text shown to the user: API description plus the catalog code, e.g. "Este e-mail já está cadastrado. (A0002)". */
export function userMessage(error) {
  if (error instanceof ApiError) {
    return error.code ? `${error.description} (${error.code})` : error.description;
  }
  return 'Erro inesperado. Tente novamente.';
}

let unauthorizedHandler = null;

/** Registers the callback fired when an authenticated call receives 401 (A0003). */
export function onUnauthorized(handler) {
  unauthorizedHandler = handler;
}

function notifyUnauthorized(error) {
  if (typeof unauthorizedHandler === 'function') unauthorizedHandler(error);
}

/** JSON request. Resolves with the parsed body (or null for an empty body); rejects with ApiError. */
export async function request(method, path, { token = null, body, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const init = { method, headers, signal, credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw networkError();
  }

  const text = await response.text();
  if (!response.ok) {
    const error = errorFromResponse({
      status: response.status,
      bodyText: text,
      retryAfter: response.headers.get('Retry-After'),
      correlationId: response.headers.get('x-correlation-id'),
    });
    if (response.status === 401 && token) notifyUnauthorized(error);
    throw error;
  }
  if (!text) return null;
  const parsed = safeJson(text);
  if (parsed === null) {
    throw new ApiError({ status: response.status, description: 'Resposta inválida do servidor.' });
  }
  return parsed;
}

export const api = {
  /** `acceptPrivacyPolicy: true` is mandatory (contratos.md, section 12); without it → 400 X0001. */
  register: ({ name, email, password }) =>
    request('POST', '/auth/register', {
      body: { name, email, password, acceptPrivacyPolicy: true },
    }),
  login: (email, password) => request('POST', '/auth/login', { body: { email, password } }),
  me: (token) => request('GET', '/auth/me', { token }),
  /** LGPD access/portability (art. 18 II and V): user without hash, videos and status history. */
  myData: (token) => request('GET', '/me/data', { token }),
  /** LGPD erasure (art. 18 VI): 204 on success, 400 A0004 when the password does not match. */
  deleteAccount: (token, password) => request('DELETE', '/me', { token, body: { password } }),
  listVideos: (token, { page = 1, limit = 20, status = '' } = {}, signal) => {
    const query = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (status) query.set('status', status);
    return request('GET', `/videos?${query.toString()}`, { token, signal });
  },
  getVideo: (token, id) => request('GET', `/videos/${encodeURIComponent(id)}`, { token }),
  /** 200 {url, expiresAt} · 409 V0004 (not ready) · 410 V0006 (zip removed by retention). */
  createDownloadUrl: (token, id) =>
    request('POST', `/videos/${encodeURIComponent(id)}/download-url`, { token }),
};

/**
 * Only follows download links that point to this API's signed-download route, on the page's own
 * origin. The API builds the URL from PUBLIC_BASE_URL; re-anchoring it here keeps local runs and
 * port-forwards working and blocks open redirects or `javascript:` URLs.
 */
export function safeDownloadUrl(rawUrl, origin) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl), origin);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!parsed.pathname.startsWith(`${API_BASE}/downloads/`)) return null;
  return `${origin}${parsed.pathname}${parsed.search}`;
}

/**
 * Multipart upload of ONE file (field `video`) with upload progress. XMLHttpRequest is used
 * because fetch() has no upload progress events.
 *
 * @returns {{ promise: Promise<object>, abort: () => void }}
 */
export function uploadVideo({ file, token, idempotencyKey, correlationId, onProgress, onSent }) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', `${API_BASE}/videos`);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Idempotency-Key', idempotencyKey);
    if (correlationId) xhr.setRequestHeader('x-correlation-id', correlationId);

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded, event.total);
    });
    xhr.upload.addEventListener('load', () => {
      if (onSent) onSent();
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(safeJson(xhr.responseText) ?? {});
        return;
      }
      const error = errorFromResponse({
        status: xhr.status,
        bodyText: xhr.responseText,
        retryAfter: xhr.getResponseHeader('Retry-After'),
        correlationId: xhr.getResponseHeader('x-correlation-id'),
      });
      if (xhr.status === 401) notifyUnauthorized(error);
      reject(error);
    });
    xhr.addEventListener('error', () => reject(networkError()));
    xhr.addEventListener('abort', () =>
      reject(new DOMException('Upload cancelado.', 'AbortError')),
    );

    const form = new FormData();
    form.append('video', file, file.name);
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}
