import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import { waitFor } from '../../../test/support/wait-for';
import { FIXTURES_DIR, stack } from './env';

/** Marker present in every BDD user name and file name (the log scenario looks for it). */
export const PERSONAL_MARKER = 'Pessoa Teste BDD';
export const FILE_MARKER = 'bdd-arquivo-pessoal';
/** Every BDD user e-mail uses this domain (the log scenario looks for it). */
export const EMAIL_DOMAIN = 'example.com';

export interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

export interface RequestOptions {
  token?: string;
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
}

/** Plain fetch against the running video-api (`/api/...`). */
export async function api<T = Record<string, unknown>>(
  method: string,
  pathAndQuery: string,
  options: RequestOptions = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers['authorization'] = `Bearer ${options.token}`;
  let body: string | FormData | undefined;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.form) {
    body = options.form;
  }
  const url = pathAndQuery.startsWith('http') ? pathAndQuery : `${stack.apiUrl}${pathAndQuery}`;
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(60_000) });
  const type = res.headers.get('content-type') ?? '';
  const parsed: unknown = type.includes('application/json')
    ? await res.json()
    : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: parsed as T, headers: res.headers };
}

/** `error.code` of an `AppError` response body. */
export function errorCode(response: { body: unknown }): string | undefined {
  return (response.body as { error?: { code?: string } }).error?.code;
}

export interface TestUser {
  id: string;
  name: string;
  email: string;
  password: string;
  token: string;
}

export function newUserData(): Omit<TestUser, 'id' | 'token'> {
  const suffix = randomUUID().slice(0, 12);
  return {
    name: `${PERSONAL_MARKER} ${suffix}`,
    email: `bdd.${suffix}@${EMAIL_DOMAIN}`,
    password: `senha-bdd-${suffix}`,
  };
}

/** Registers (with privacy consent) and logs in a brand-new user. */
export async function createUser(): Promise<TestUser> {
  const data = newUserData();
  const registered = await api<{ id: string }>('POST', '/api/auth/register', {
    json: { ...data, acceptPrivacyPolicy: true },
  });
  if (registered.status !== 201) {
    throw new Error(`cadastro falhou: ${registered.status} ${JSON.stringify(registered.body)}`);
  }
  const login = await api<{ accessToken: string }>('POST', '/api/auth/login', {
    json: { email: data.email, password: data.password },
  });
  if (login.status !== 200) {
    throw new Error(`login falhou: ${login.status} ${JSON.stringify(login.body)}`);
  }
  return { ...data, id: registered.body.id, token: login.body.accessToken };
}

export interface UploadOptions {
  /** File name sent in the multipart part (default: a personal-looking marker name). */
  fileName?: string;
  correlationId?: string;
  idempotencyKey?: string;
}

export interface UploadedVideo {
  id: string;
  originalName: string;
  status: string;
}

/** `POST /api/videos` with a sample from examples/ (field `video`). */
export async function uploadFixture(
  token: string | undefined,
  fixture: string,
  options: UploadOptions = {},
): Promise<ApiResponse<UploadedVideo>> {
  const blob = await openAsBlob(path.join(FIXTURES_DIR, fixture), { type: 'video/mp4' });
  const form = new FormData();
  const fileName = options.fileName ?? `${FILE_MARKER}-${randomUUID().slice(0, 8)}.mp4`;
  form.append('video', blob, fileName);
  const headers: Record<string, string> = {};
  if (options.correlationId) headers['x-correlation-id'] = options.correlationId;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  return api<UploadedVideo>('POST', '/api/videos', { token, form, headers });
}

export interface VideoDetail {
  id: string;
  status: string;
  frameCount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  expiredAt: string | null;
  downloadAvailable: boolean;
  history: Array<{ fromStatus: string | null; toStatus: string }>;
}

export const TERMINAL_STATUSES = ['COMPLETED', 'FAILED'];

/** Polls `GET /api/videos/:id` until the video reaches COMPLETED or FAILED. */
export async function waitForTerminal(
  token: string,
  videoId: string,
  timeoutMs = 120_000,
): Promise<VideoDetail> {
  return waitFor(
    async () => {
      const res = await api<VideoDetail>('GET', `/api/videos/${videoId}`, { token });
      return TERMINAL_STATUSES.includes(res.body.status) ? res.body : undefined;
    },
    { timeoutMs, intervalMs: 1_000, description: `vídeo ${videoId} em estado terminal` },
  );
}

/** Uploads `sample-ok-5s.mp4` and waits until it is COMPLETED. */
export async function uploadProcessedVideo(user: TestUser): Promise<VideoDetail> {
  const upload = await uploadFixture(user.token, 'sample-ok-5s.mp4');
  if (upload.status !== 202) throw new Error(`upload falhou: ${upload.status}`);
  const detail = await waitForTerminal(user.token, upload.body.id);
  if (detail.status !== 'COMPLETED') throw new Error(`vídeo terminou em ${detail.status}`);
  return detail;
}
