import { defineFeature, loadFeature } from 'jest-cucumber';
import { waitFor } from '../../../test/support/wait-for';
import { api, errorCode } from '../support/api';
import type { MailpitMessage } from '../support/services';
import { mailDetail, mailsTo } from '../support/services';
import type { World } from '../support/world';
import {
  givenAuthenticatedUser,
  requireUser,
  requireVideoId,
  thenAcceptedQueued,
  thenRawDeleted,
  waitUploadedVideo,
  whenUploadCorruptWithCorrelation,
} from '../support/world';

const feature = loadFeature('tests/bdd/features/02-falha.feature');

defineFeature(feature, (test) => {
  test('vídeo corrompido termina em FALHOU e usuário recebe e-mail', ({
    given,
    when,
    then,
    and,
  }) => {
    const world: World = {};
    let mail: MailpitMessage | undefined;

    givenAuthenticatedUser(given, world);
    whenUploadCorruptWithCorrelation(when, world);
    thenAcceptedQueued(then, world);

    and(
      /^o vídeo termina em FALHOU com status "(.*)" e o código "(.*)"$/,
      async (status: string, code: string) => {
        const video = await waitUploadedVideo(world);
        expect(video.status).toBe(status);
        expect(video.errorCode).toBe(code);
        expect(video.errorMessage).toEqual(expect.any(String));
        expect(video.history.map((entry) => entry.toStatus)).toEqual([
          'QUEUED',
          'PROCESSING',
          'FAILED',
        ]);
      },
    );

    thenRawDeleted(and, world);

    and('eu recebo um e-mail avisando que o vídeo não pôde ser processado', async () => {
      const email = requireUser(world).email;
      const [found] = await waitFor(
        async () => {
          const messages = await mailsTo(email);
          return messages.length > 0 ? messages : undefined;
        },
        { timeoutMs: 60_000, intervalMs: 1_000, description: `e-mail para ${email} no Mailpit` },
      );
      mail = found;
      expect(mail?.Subject).toBe('FIAP Frames: não foi possível processar o seu vídeo');
      const detail = await mailDetail(mail?.ID ?? '');
      expect(detail.text).toContain('P0001');
    });

    and('o e-mail traz o mesmo correlation id do envio', async () => {
      const detail = await mailDetail(mail?.ID ?? '');
      expect(detail.headers['X-Correlation-Id']).toEqual([world.correlationId]);
    });

    and(
      /^o download do zip é recusado com status (\d+) e o código "(.*)"$/,
      async (status: string, code: string) => {
        const res = await api('POST', `/api/videos/${requireVideoId(world)}/download-url`, {
          token: requireUser(world).token,
        });
        expect(res.status).toBe(Number(status));
        expect(errorCode(res)).toBe(code);
      },
    );
  });
});
