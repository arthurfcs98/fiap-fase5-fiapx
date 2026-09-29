import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Registry } from '@prometheus-io/client';
import { createMetricsRegistry } from './metrics-registry';
import type { MetricsServerOptions } from './metrics-server';
import { MetricsServer } from './metrics-server';

const TOKEN = 'token-de-metricas-123';

async function withServer(
  overrides: Partial<MetricsServerOptions>,
  fn: (baseUrl: string, server: MetricsServer) => Promise<void>,
): Promise<void> {
  const registry = overrides.registry ?? createMetricsRegistry('video-worker');
  const server = new MetricsServer({
    serviceName: 'video-worker',
    version: 'sha-abc1234',
    port: 0,
    host: '127.0.0.1',
    registry,
    ...overrides,
  });
  const port = await server.start();
  try {
    await fn(`http://127.0.0.1:${port}`, server);
  } finally {
    await server.stop();
    registry.clear();
  }
}

describe('MetricsServer', () => {
  it('GET /health responde 200 com serviço e versão', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/health?probe=docker`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({
        status: 'ok',
        service: 'video-worker',
        version: 'sha-abc1234',
      });
    });
  });

  it('HEAD /health responde sem corpo', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/health`, { method: 'HEAD' });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
    });
  });

  it('/health responde 503 durante o shutdown', async () => {
    await withServer({ isReady: () => false }, async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ status: 'shutting_down' });
    });
  });

  it('/health responde 503 unhealthy com as verificações internas que falham', async () => {
    await withServer({ failingChecks: () => ['consumer:worker.video-uploaded'] }, async (base) => {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        status: 'unhealthy',
        service: 'video-worker',
        version: 'sha-abc1234',
        failing: ['consumer:worker.video-uploaded'],
      });
    });
  });

  it('/health fica 200 quando as verificações internas passam', async () => {
    await withServer({ failingChecks: () => [] }, async (base) => {
      expect((await fetch(`${base}/health`)).status).toBe(200);
    });
  });

  it('GET /metrics expõe o registry no formato Prometheus', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(await res.text()).toMatch(/process_cpu_user_seconds_total\{service="video-worker"\}/);
    });
  });

  it('HEAD /metrics responde sem corpo', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/metrics`, { method: 'HEAD' });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
    });
  });

  it('exige Bearer token em /metrics quando configurado (e /health continua aberto)', async () => {
    await withServer({ token: TOKEN }, async (base) => {
      const noToken = await fetch(`${base}/metrics`);
      expect(noToken.status).toBe(401);
      expect(noToken.headers.get('www-authenticate')).toBe('Bearer');

      const wrong = await fetch(`${base}/metrics`, {
        headers: { authorization: `Bearer ${'x'.repeat(TOKEN.length)}` },
      });
      expect(wrong.status).toBe(401);

      const ok = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(ok.status).toBe(200);

      expect((await fetch(`${base}/health`)).status).toBe(200);
    });
  });

  it('responde 404 para rotas desconhecidas e 405 para métodos não suportados', async () => {
    await withServer({}, async (base) => {
      const notFound = await fetch(`${base}/api/videos`);
      expect(notFound.status).toBe(404);

      const notAllowed = await fetch(`${base}/metrics`, { method: 'POST' });
      expect(notAllowed.status).toBe(405);
      expect(notAllowed.headers.get('allow')).toBe('GET, HEAD');
    });
  });

  it('responde 500 se a coleta de métricas falhar', async () => {
    const registry = new Registry();
    jest.spyOn(registry, 'metrics').mockRejectedValue(new Error('coleta falhou'));
    await withServer({ registry }, async (base) => {
      expect((await fetch(`${base}/metrics`)).status).toBe(500);
    });
  });

  it('trata request sem método/url como GET /', async () => {
    const server = new MetricsServer({
      serviceName: 's',
      version: 'v',
      port: 0,
      registry: new Registry(),
    });
    const res = { setHeader: jest.fn(), writeHead: jest.fn(), end: jest.fn() };
    await server.handle({ headers: {} } as never, res as never);
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  });

  it('não pode ser iniciado duas vezes; stop é idempotente; porta indefinida antes do start', async () => {
    await withServer({}, async (_base, server) => {
      await expect(server.start()).rejects.toThrow('já foi iniciado');
      expect(server.port).toEqual(expect.any(Number));
    });
    const idle = new MetricsServer({
      serviceName: 's',
      version: 'v',
      port: 0,
      registry: new Registry(),
    });
    expect(idle.port).toBeUndefined();
    await expect(idle.stop()).resolves.toBeUndefined();
  });

  it('propaga erro de porta ocupada e permite nova tentativa', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as AddressInfo;
    const server = new MetricsServer({
      serviceName: 's',
      version: 'v',
      port,
      host: '127.0.0.1',
      registry: new Registry(),
    });

    try {
      await expect(server.start()).rejects.toThrow(/EADDRINUSE/);
      expect(server.port).toBeUndefined();
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
    await expect(server.start()).resolves.toBe(port);
    await server.stop();
  });

  it('usa todas as interfaces quando host não é informado', async () => {
    const server = new MetricsServer({
      serviceName: 's',
      version: 'v',
      port: 0,
      registry: new Registry(),
    });
    const port = await server.start();
    try {
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    } finally {
      await server.stop();
    }
  });
});
