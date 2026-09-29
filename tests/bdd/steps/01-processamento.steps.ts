import { defineFeature, loadFeature } from 'jest-cucumber';
import type { ApiResponse } from '../support/api';
import { api, uploadFixture } from '../support/api';
import type { World } from '../support/world';
import {
  givenAuthenticatedUser,
  requireUser,
  requireVideoId,
  thenAcceptedQueued,
  thenRawDeleted,
  waitUploadedVideo,
} from '../support/world';
import { zipEntries } from '../support/zip';

const feature = loadFeature('tests/bdd/features/01-processamento.feature');

defineFeature(feature, (test) => {
  test('usuário processa vídeo e baixa o zip', ({ given, when, then, and }) => {
    const world: World = {};
    let link: ApiResponse<{ url: string; expiresAt: string }> | undefined;

    givenAuthenticatedUser(given, world);

    when(/^envio o vídeo "(.*)" de 5 segundos$/, async (fixture: string) => {
      world.upload = await uploadFixture(requireUser(world).token, fixture);
    });

    thenAcceptedQueued(then, world);

    and(
      /^o vídeo termina com status "(.*)" e (\d+) frames$/,
      async (status: string, frames: string) => {
        const video = await waitUploadedVideo(world);
        expect(video.status).toBe(status);
        expect(video.frameCount).toBe(Number(frames));
        expect(video.downloadAvailable).toBe(true);
      },
    );

    and('o histórico mostra QUEUED, PROCESSING e COMPLETED', () => {
      expect(world.video?.history.map((entry) => entry.toStatus)).toEqual([
        'QUEUED',
        'PROCESSING',
        'COMPLETED',
      ]);
    });

    thenRawDeleted(and, world);

    when('peço o link de download do zip', async () => {
      link = await api('POST', `/api/videos/${requireVideoId(world)}/download-url`, {
        token: requireUser(world).token,
      });
      expect(link.status).toBe(200);
      expect(new Date(link.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    then(/^baixo um arquivo zip com (\d+) imagens PNG$/, async (count: string) => {
      // The signed link needs no token (contratos.md, section 8).
      const download = await api<Buffer>('GET', link?.body.url ?? '');
      expect(download.status).toBe(200);
      expect(download.headers.get('content-type')).toBe('application/zip');
      const entries = zipEntries(download.body);
      expect(entries).toHaveLength(Number(count));
      expect(entries.every((name) => /^frame_\d{4}\.png$/.test(name))).toBe(true);
    });
  });
});
