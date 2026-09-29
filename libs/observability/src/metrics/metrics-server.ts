import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { Registry } from '@prometheus-io/client';

export interface MetricsServerOptions {
  serviceName: string;
  version: string;
  port: number;
  host?: string;
  registry: Registry;
  /** Token Bearer exigido em `/metrics` (opcional). */
  token?: string;
  /** Retorna false durante o shutdown: `/health` passa a responder 503. */
  isReady?: () => boolean;
  /** Verificações internas que falham agora (ex.: consumidor de fila morto): `/health` 503. */
  failingChecks?: () => string[];
}

/**
 * Servidor HTTP mínimo (sem Express) para serviços sem API pública (worker e notification):
 * - `GET /health`  → 200 `{status:"ok", service, version}`; 503 `shutting_down` durante o
 *   shutdown e 503 `unhealthy` (com os nomes em `failing`) se uma verificação interna falhar;
 * - `GET /metrics` → exposição Prometheus do registry (com token opcional).
 * Fica só na rede interna: a porta não é publicada na borda.
 */
export class MetricsServer {
  private server?: Server;

  constructor(private readonly options: MetricsServerOptions) {}

  /** Porta efetiva (útil com `port: 0` nos testes). */
  get port(): number | undefined {
    const address = this.server?.address();
    return typeof address === 'object' && address !== null ? address.port : undefined;
  }

  async start(): Promise<number> {
    if (this.server) throw new Error('MetricsServer já foi iniciado');
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, this.options.host ?? '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    }).catch((error: unknown) => {
      this.server = undefined;
      throw error;
    });

    return this.port ?? this.options.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0];
    const headOnly = method === 'HEAD';

    if (path !== '/health' && path !== '/metrics') {
      return sendJson(res, 404, { status: 'not_found' }, headOnly);
    }
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return sendJson(res, 405, { status: 'method_not_allowed' }, false);
    }

    if (path === '/health') {
      const identity = { service: this.options.serviceName, version: this.options.version };
      if (!(this.options.isReady?.() ?? true)) {
        return sendJson(res, 503, { status: 'shutting_down', ...identity }, headOnly);
      }
      const failing = this.options.failingChecks?.() ?? [];
      if (failing.length > 0) {
        return sendJson(res, 503, { status: 'unhealthy', ...identity, failing }, headOnly);
      }
      return sendJson(res, 200, { status: 'ok', ...identity }, headOnly);
    }

    if (!this.isAuthorized(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return sendJson(res, 401, { status: 'unauthorized' }, headOnly);
    }

    try {
      const body = await this.options.registry.metrics();
      res.writeHead(200, { 'Content-Type': this.options.registry.contentType });
      res.end(headOnly ? undefined : body);
    } catch {
      sendJson(res, 500, { status: 'error' }, headOnly);
    }
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const token = this.options.token;
    if (!token) return true;
    const expected = Buffer.from(`Bearer ${token}`);
    const received = Buffer.from(req.headers.authorization ?? '');
    return received.length === expected.length && timingSafeEqual(received, expected);
  }
}

function sendJson(res: ServerResponse, status: number, body: object, headOnly: boolean): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(headOnly ? undefined : payload);
}
