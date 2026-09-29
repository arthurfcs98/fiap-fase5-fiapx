import { defineFeature, loadFeature } from 'jest-cucumber';
import { waitFor } from '../../../test/support/wait-for';
import { metricsOf, metricsStatusWithoutToken, stackLogs } from '../support/compose';
import type { World } from '../support/world';
import {
  givenAuthenticatedUser,
  waitUploadedVideo,
  whenUploadCorruptWithCorrelation,
} from '../support/world';

const feature = loadFeature('tests/bdd/features/07-observabilidade.feature');

/** Metrics of contratos.md, section 11 (+ the HTTP histogram of section 13), per service. */
const CONTRACT_METRICS: Record<string, string[]> = {
  'video-api': [
    'fiapx_videos_uploaded_total',
    'fiapx_videos_completed_total',
    'fiapx_videos_failed_total',
    'fiapx_outbox_pending',
    'fiapx_messages_consumed_total',
    'fiapx_http_request_duration_seconds',
  ],
  'video-worker': [
    'fiapx_video_processing_duration_seconds',
    'fiapx_worker_in_flight',
    'fiapx_worker_jobs_total',
    'fiapx_messages_consumed_total',
  ],
  'notification-service': ['fiapx_notifications_total', 'fiapx_messages_consumed_total'],
};

defineFeature(feature, (test) => {
  test('/metrics exige token e expõe as métricas HTTP e de negócio', ({ when, then, and }) => {
    let status = 0;
    let metrics = '';

    when('consulto o /metrics do video-api sem token', async () => {
      status = await metricsStatusWithoutToken('video-api');
    });

    then(/^o \/metrics responde (\d+)$/, (expected: string) => {
      expect(status).toBe(Number(expected));
    });

    when('consulto o /metrics do video-api com o token', async () => {
      metrics = await metricsOf('video-api');
    });

    then(/^vejo o histograma "(.*)" da rota "(.*)"$/, (name: string, route: string) => {
      expect(metrics).toContain(`# TYPE ${name} histogram`);
      const buckets = metrics
        .split('\n')
        .filter((line) => line.startsWith(`${name}_bucket{`) && line.includes(`route="${route}"`));
      expect(buckets.length).toBeGreaterThan(0);
    });

    and('vejo as métricas de negócio do contrato nos 3 serviços', async () => {
      for (const [service, names] of Object.entries(CONTRACT_METRICS)) {
        const text = service === 'video-api' ? metrics : await metricsOf(service);
        for (const name of names) {
          expect(`${service}: ${text.includes(`# TYPE ${name} `) ? name : 'ausente'}`).toBe(
            `${service}: ${name}`,
          );
        }
      }
    });
  });

  test('o correlation id atravessa API, worker e notificação', ({ given, when, then, and }) => {
    const world: World = {};

    givenAuthenticatedUser(given, world);
    whenUploadCorruptWithCorrelation(when, world);

    and(/^o vídeo termina com status "(.*)"$/, async (status: string) => {
      expect((await waitUploadedVideo(world)).status).toBe(status);
    });

    then(
      'os logs do video-api, do video-worker e do notification-service mostram esse correlation id',
      async () => {
        const id = world.correlationId ?? '';
        for (const service of ['video-api', 'video-worker', 'notification-service']) {
          await waitFor(
            async () => (await stackLogs([service])).includes(`"correlationId":"${id}"`),
            {
              timeoutMs: 30_000,
              intervalMs: 1_000,
              description: `correlationId ${id} nos logs do ${service}`,
            },
          );
        }
      },
    );
  });
});
