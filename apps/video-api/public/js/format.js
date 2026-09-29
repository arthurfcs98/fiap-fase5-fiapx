/*
 * Pure helpers (no DOM): formatting, labels and small utilities shared by the UI modules.
 * Kept free of browser-only APIs where possible so they can be exercised with `node --test`.
 */

/** Extensions accepted by the API (contratos.md, section 8). */
export const ALLOWED_EXTENSIONS = Object.freeze([
  '.mp4',
  '.avi',
  '.mov',
  '.mkv',
  '.wmv',
  '.flv',
  '.webm',
]);

/** Default upload limit (MAX_UPLOAD_MB). The server is authoritative; this only saves bandwidth. */
export const DEFAULT_MAX_UPLOAD_MB = 95;

/** Uploads in flight at the same time (one POST /api/videos per file). */
export const MAX_PARALLEL_UPLOADS = 3;

/** Days a .zip stays downloadable (ZIP_RETENTION_DAYS default, contratos.md section 12). */
export const ZIP_RETENTION_DAYS = 7;

/** Password rule of the API (registerSchema): at least 8 characters and at most 72 UTF-8 bytes. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

export const VIDEO_STATUSES = Object.freeze(['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED']);

const STATUS_LABELS = Object.freeze({
  QUEUED: 'Na fila',
  PROCESSING: 'Processando',
  COMPLETED: 'Concluído',
  FAILED: 'Falhou',
});

/** Friendly fallback for processing error codes (videos.error_code), used when errorMessage is empty. */
const PROCESSING_ERROR_MESSAGES = Object.freeze({
  P0001: 'O arquivo não é um vídeo válido ou está corrompido.',
  P0002: 'Nenhum frame pôde ser extraído do vídeo.',
  P0003: 'O vídeo é mais longo que o limite permitido.',
  P0004: 'O processamento excedeu o tempo limite.',
  P0005: 'O arquivo enviado não foi encontrado no armazenamento.',
  P0098: 'O processamento falhou depois de várias tentativas.',
  P0099: 'O processamento foi interrompido.',
});

const numberFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const integerFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
});
const timeFormat = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'medium' });
const relativeFormat = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });

export function statusLabel(status) {
  return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : String(status ?? '—');
}

/** Lower-cased extension including the dot (".mp4"), or "" when the name has none. */
export function fileExtension(name) {
  const value = String(name ?? '');
  const dot = value.lastIndexOf('.');
  return dot > 0 && dot < value.length - 1 ? value.slice(dot).toLowerCase() : '';
}

export function isAllowedVideoName(name) {
  return ALLOWED_EXTENSIONS.includes(fileExtension(name));
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${integerFormat.format(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${numberFormat.format(scaled)} ${units[unit]}`;
}

export function formatCount(value) {
  const number = Number(value);
  return value === null || value === undefined || !Number.isFinite(number)
    ? '—'
    : integerFormat.format(number);
}

export function formatPercent(loaded, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.floor((loaded / total) * 100)));
}

function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value) {
  const date = toDate(value);
  return date ? dateTimeFormat.format(date) : '—';
}

export function formatClock(value) {
  const date = toDate(value);
  return date ? timeFormat.format(date) : '—';
}

/** "agora", "há 5 minutos", "ontem"… Falls back to the absolute date after a week. */
export function formatRelative(value, now = Date.now()) {
  const date = toDate(value);
  if (!date) return '—';
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'agora';
  if (abs < 3600) return relativeFormat.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relativeFormat.format(Math.round(seconds / 3600), 'hour');
  if (abs < 7 * 86_400) return relativeFormat.format(Math.round(seconds / 86_400), 'day');
  return dateTimeFormat.format(date);
}

/** Error shown for a FAILED video: server message first, catalog text as fallback. */
export function describeVideoError(video) {
  const code = typeof video?.errorCode === 'string' && video.errorCode ? video.errorCode : null;
  const serverMessage =
    typeof video?.errorMessage === 'string' && video.errorMessage.trim()
      ? video.errorMessage.trim()
      : null;
  const fallback =
    code && Object.hasOwn(PROCESSING_ERROR_MESSAGES, code)
      ? PROCESSING_ERROR_MESSAGES[code]
      : 'Não foi possível processar o vídeo.';
  return { code, message: serverMessage ?? fallback };
}

/**
 * True when the retention job removed the zip (`expiredAt` filled) or the API already answered
 * 410 V0006 for this video (`knownExpired`, kept by the UI until the list reflects it).
 */
export function isZipExpired(video, knownExpired = null) {
  if (!video) return false;
  if (toDate(video.expiredAt) !== null) return true;
  return Boolean(knownExpired && knownExpired.has(video.id));
}

/** "12 s", "3 min 05 s", "1 h 02 min". */
export function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  const total = Math.round(value / 1000);
  if (total < 60) return `${total} s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min`;
  return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
}

/** Processing time of a finished video (startedAt → completedAt), or null when unknown. */
export function processingTime(video) {
  const started = toDate(video?.startedAt);
  const completed = toDate(video?.completedAt);
  if (!started || !completed || completed < started) return null;
  return completed.getTime() - started.getTime();
}

/** Attempt counter from the list item; the API may expose `attempts` (DB column) or `attempt`. */
export function videoAttempts(video) {
  const value = Number(video?.attempts ?? video?.attempt);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Parses a Retry-After header (delta-seconds or HTTP-date). Returns seconds (>= 0) or null.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

export function initials(name) {
  const parts = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0].charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
  return (first + last).toUpperCase();
}

/** UUID v4. `crypto.randomUUID` only exists in secure contexts (HTTPS/localhost). */
export function uuid(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID === 'function') return cryptoImpl.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** UTF-8 byte length (bcrypt only uses the first 72 bytes of a password). */
export function byteLength(text) {
  return new TextEncoder().encode(String(text ?? '')).length;
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** First broken password rule as a pt-BR sentence, or null when the password is acceptable. */
export function passwordProblem(password) {
  const value = String(password ?? '');
  if (value.length < PASSWORD_MIN_LENGTH) {
    return `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  }
  if (byteLength(value) > PASSWORD_MAX_BYTES) {
    return `A senha pode ter no máximo ${PASSWORD_MAX_BYTES} bytes (cerca de ${PASSWORD_MAX_BYTES} caracteres sem acento).`;
  }
  return null;
}

/** File name of the LGPD export, e.g. "fiap-frames-meus-dados-2026-09-28.json" (local date). */
export function exportFileName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `fiap-frames-meus-dados-${day}.json`;
}
