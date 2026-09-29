import { defineFeature, loadFeature } from 'jest-cucumber';
import { waitFor } from '../../../test/support/wait-for';
import type { ApiResponse, UploadedVideo, VideoDetail } from '../support/api';
import { uploadFixture, waitForTerminal } from '../support/api';
import { metricsOf, metricValue, runningReplicas } from '../support/compose';
import { queueDepth } from '../support/services';
import type { World } from '../support/world';
import { givenAuthenticatedUser, requireUser } from '../support/world';

const feature = loadFeature('tests/bdd/features/04-pico.feature');

const DEAD_LETTER_QUEUES = [
  'worker.video-uploaded.dlq',
  'api.video-processing.dlq',
  'notification.events.dlq',
];

/** `fiapx_worker_jobs_total{result="completed"}` of each worker replica. */
async function completedJobsPerWorker(replicas: number): Promise<number[]> {
  const counts: number[] = [];
  for (let index = 1; index <= replicas; index += 1) {
    const metrics = await metricsOf('video-worker', index);
    counts.push(metricValue(metrics, 'fiapx_worker_jobs_total', { result: 'completed' }));
  }
  return counts;
}

async function deadLetterDepths(): Promise<number[]> {
  return Promise.all(DEAD_LETTER_QUEUES.map((queue) => queueDepth(queue)));
}

defineFeature(feature, (test) => {
  test('15 uploads simultâneos são todos aceitos e processados por 2 ou mais workers', ({
    given,
    when,
    then,
    and,
  }) => {
    const world: World = {};
    let replicas = 0;
    let jobsBefore: number[] = [];
    let dlqBefore: number[] = [];
    let uploads: Array<ApiResponse<UploadedVideo>> = [];
    let videos: VideoDetail[] = [];

    given(/^que há pelo menos (\d+) workers em execução$/, async (minimum: string) => {
      replicas = await runningReplicas('video-worker');
      if (replicas < Number(minimum)) {
        throw new Error(
          `só ${replicas} video-worker em execução: suba com "make test-bdd" ou ` +
            '"docker compose up -d --scale video-worker=3"',
        );
      }
      jobsBefore = await completedJobsPerWorker(replicas);
      dlqBefore = await deadLetterDepths();
    });

    givenAuthenticatedUser(and, world);

    when(/^envio (\d+) vídeos ao mesmo tempo$/, async (count: string) => {
      const token = requireUser(world).token;
      uploads = await Promise.all(
        Array.from({ length: Number(count) }, () => uploadFixture(token, 'sample-ok-5s.mp4')),
      );
    });

    then(/^todas as (\d+) requisições são aceitas com status 202$/, (count: string) => {
      expect(uploads).toHaveLength(Number(count));
      expect(uploads.map((upload) => upload.status)).toEqual(
        Array.from({ length: Number(count) }, () => 202),
      );
      expect(new Set(uploads.map((upload) => upload.body.id)).size).toBe(Number(count));
    });

    and(
      /^todos os (\d+) vídeos terminam com status "(.*)"$/,
      async (count: string, status: string) => {
        const token = requireUser(world).token;
        videos = await Promise.all(
          uploads.map((upload) => waitForTerminal(token, upload.body.id, 180_000)),
        );
        expect(videos).toHaveLength(Number(count));
        expect(videos.filter((video) => video.status === status)).toHaveLength(Number(count));
      },
    );

    and(/^pelo menos (\d+) workers diferentes processaram vídeos$/, async (minimum: string) => {
      const jobsAfter = await completedJobsPerWorker(replicas);
      const delta = jobsAfter.map((after, index) => after - (jobsBefore[index] ?? 0));
      expect(delta.reduce((sum, value) => sum + value, 0)).toBeGreaterThanOrEqual(videos.length);
      expect(delta.filter((value) => value > 0).length).toBeGreaterThanOrEqual(Number(minimum));
    });

    and('nenhuma mensagem foi para as filas de dead-letter', async () => {
      expect(await deadLetterDepths()).toEqual(dlqBefore);
    });

    and('o outbox do video-api não tem eventos pendentes', async () => {
      await waitFor(
        async () => metricValue(await metricsOf('video-api'), 'fiapx_outbox_pending') === 0,
        { timeoutMs: 30_000, intervalMs: 1_000, description: 'fiapx_outbox_pending = 0' },
      );
    });
  }, 300_000);
});
