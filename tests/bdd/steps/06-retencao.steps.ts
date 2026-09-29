import { defineFeature, loadFeature } from 'jest-cucumber';
import { waitFor } from '../../../test/support/wait-for';
import type { VideoDetail } from '../support/api';
import { api, errorCode } from '../support/api';
import { containerEnvSync } from '../support/compose';
import { BUCKETS, listKeys } from '../support/storage';
import type { World } from '../support/world';
import {
  givenAuthenticatedUser,
  givenProcessedVideo,
  requireUser,
  requireVideoId,
} from '../support/world';

const feature = loadFeature('tests/bdd/features/06-retencao.feature');

/** Longest retention the scenario waits for (make test-bdd uses ~43 s). */
const MAX_WAIT_S = 300;
const DAY_S = 86_400;

const retentionDays = Number(containerEnvSync('video-api', 'ZIP_RETENTION_DAYS') ?? '7');
const intervalS = Number(containerEnvSync('video-api', 'DATA_RETENTION_INTERVAL_S') ?? '3600');
const waitS = retentionDays * DAY_S + intervalS;

if (Number.isFinite(waitS) && waitS <= MAX_WAIT_S) {
  defineFeature(feature, (test) => {
    test(
      'zip expira depois do prazo de retenção',
      ({ given, when, then, and }) => {
        const world: World = {};
        let signedUrl = '';

        given('que o stack está com um prazo de retenção de zip curto', () => {
          expect(waitS).toBeLessThanOrEqual(MAX_WAIT_S);
        });

        givenAuthenticatedUser(and, world);
        givenProcessedVideo(and, world);

        when('o prazo de retenção do zip passa', async () => {
          const token = requireUser(world).token;
          const videoId = requireVideoId(world);
          // A link signed BEFORE the expiry must stop working too.
          const link = await api<{ url: string }>('POST', `/api/videos/${videoId}/download-url`, {
            token,
          });
          expect(link.status).toBe(200);
          signedUrl = link.body.url;
          world.video = await waitFor(
            async () => {
              const res = await api<VideoDetail>('GET', `/api/videos/${videoId}`, { token });
              return res.body.expiredAt ? res.body : undefined;
            },
            {
              timeoutMs: (waitS + 60) * 1000,
              intervalMs: 2_000,
              description: 'zip expirado (expiredAt preenchido)',
            },
          );
        });

        then('o vídeo fica marcado como expirado', () => {
          expect(world.video?.status).toBe('COMPLETED');
          expect(world.video?.expiredAt).toEqual(expect.any(String));
          expect(world.video?.downloadAvailable).toBe(false);
        });

        and(
          /^o link de download responde (\d+) com o código "(.*)"$/,
          async (status: string, code: string) => {
            const download = await api('GET', signedUrl);
            expect(download.status).toBe(Number(status));
            expect(errorCode(download)).toBe(code);
            const newLink = await api('POST', `/api/videos/${requireVideoId(world)}/download-url`, {
              token: requireUser(world).token,
            });
            expect(newLink.status).toBe(Number(status));
            expect(errorCode(newLink)).toBe(code);
          },
        );

        and('o zip é apagado do bucket', async () => {
          const prefix = `${requireUser(world).id}/${requireVideoId(world)}`;
          expect(await listKeys(BUCKETS.zips, prefix)).toEqual([]);
        });
      },
      (waitS + 180) * 1000,
    );
  });
} else {
  describe(`Retenção do zip (LGPD): pulado, o stack está com ZIP_RETENTION_DAYS=${retentionDays}`, () => {
    it.skip('zip expira depois do prazo de retenção (rode "make test-bdd")', () => undefined);
  });
}
