import { defineFeature, loadFeature } from 'jest-cucumber';
import { waitFor } from '../../../test/support/wait-for';
import type { ApiResponse } from '../support/api';
import { api, errorCode, newUserData } from '../support/api';
import { mailsTo, queryDb } from '../support/services';
import { BUCKETS, listKeys } from '../support/storage';
import type { World } from '../support/world';
import {
  givenAuthenticatedUser,
  givenProcessedVideo,
  requireUser,
  requireVideoId,
} from '../support/world';

const feature = loadFeature('tests/bdd/features/05-privacidade.feature');

interface ExportedData {
  exportedAt: string;
  user: Record<string, unknown>;
  videos: Array<{ id: string; history: Array<{ toStatus: string }> }>;
}

defineFeature(feature, (test) => {
  test('cadastro sem aceite da política de privacidade é recusado', ({ when, then }) => {
    let res: ApiResponse | undefined;

    when('tento me cadastrar sem aceitar a política de privacidade', async () => {
      res = await api('POST', '/api/auth/register', { json: newUserData() });
    });

    then(
      /^o cadastro é recusado com status (\d+) e o código "(.*)"$/,
      (status: string, code: string) => {
        expect(res?.status).toBe(Number(status));
        expect(res && errorCode(res)).toBe(code);
        expect(JSON.stringify(res?.body)).toContain('acceptPrivacyPolicy');
      },
    );
  });

  test('cadastros simultâneos com o mesmo e-mail criam uma única conta', ({ when, then }) => {
    let responses: ApiResponse[] = [];

    when(/^(\d+) cadastros com o mesmo e-mail chegam ao mesmo tempo$/, async (count: string) => {
      const data = newUserData();
      responses = await Promise.all(
        Array.from({ length: Number(count) }, () =>
          api('POST', '/api/auth/register', { json: { ...data, acceptPrivacyPolicy: true } }),
        ),
      );
    });

    then(
      /^só um é aceito com status 201 e os demais recebem 409 com o código "(.*)"$/,
      (code: string) => {
        const statuses = responses.map((res) => res.status).sort();
        expect(statuses).toEqual([201, ...Array.from({ length: responses.length - 1 }, () => 409)]);
        const conflicts = responses.filter((res) => res.status === 409);
        expect(conflicts.every((res) => errorCode(res) === code)).toBe(true);
      },
    );
  });

  test('usuário exporta os próprios dados', ({ given, when, then, and }) => {
    const world: World = {};
    let exported: ApiResponse<ExportedData> | undefined;

    givenAuthenticatedUser(given, world);
    givenProcessedVideo(and, world);

    when('peço a exportação dos meus dados', async () => {
      exported = await api<ExportedData>('GET', '/api/me/data', {
        token: requireUser(world).token,
      });
      expect(exported.status).toBe(200);
    });

    then('recebo os meus dados cadastrais sem o hash da senha', () => {
      const user = requireUser(world);
      expect(exported?.body.user).toMatchObject({
        id: user.id,
        name: user.name,
        email: user.email,
        privacyPolicyVersion: '2026-09-28',
      });
      expect(exported?.body.user['privacyAcceptedAt']).toEqual(expect.any(String));
      expect(JSON.stringify(exported?.body).toLowerCase()).not.toContain('password');
    });

    and('a exportação lista o vídeo com o histórico de status', () => {
      const video = exported?.body.videos.find((item) => item.id === requireVideoId(world));
      expect(video?.history.map((entry) => entry.toStatus)).toEqual([
        'QUEUED',
        'PROCESSING',
        'COMPLETED',
      ]);
    });
  });

  test('usuário exclui a conta e os dados são apagados ou anonimizados', ({
    given,
    when,
    then,
    and,
  }) => {
    const world: World = {};
    let res: ApiResponse | undefined;

    givenAuthenticatedUser(given, world);
    givenProcessedVideo(and, world);

    and('que recebi o e-mail de vídeo processado', async () => {
      // compose: NOTIFY_ON_SUCCESS=true, so the notification-service stores one row.
      const user = requireUser(world);
      await waitFor(async () => (await mailsTo(user.email)).length > 0, {
        timeoutMs: 60_000,
        intervalMs: 1_000,
        description: `e-mail para ${user.email}`,
      });
      const rows = await queryDb<{ recipient: string }>(
        'fiapx_notification',
        'SELECT recipient FROM notifications WHERE user_id = $1',
        [user.id],
      );
      expect(rows.map((row) => row.recipient)).toEqual([user.email]);
    });

    when('tento excluir a conta com a senha errada', async () => {
      res = await api('DELETE', '/api/me', {
        token: requireUser(world).token,
        json: { password: 'senha-errada' },
      });
    });

    then(
      /^a exclusão é recusada com status (\d+) e o código "(.*)"$/,
      async (status: string, code: string) => {
        expect(res?.status).toBe(Number(status));
        expect(res && errorCode(res)).toBe(code);
        const me = await api('GET', '/api/auth/me', { token: requireUser(world).token });
        expect(me.status).toBe(200);
      },
    );

    when('excluo a conta com a senha correta', async () => {
      const user = requireUser(world);
      res = await api('DELETE', '/api/me', {
        token: user.token,
        json: { password: user.password },
      });
    });

    then(/^a exclusão responde (\d+)$/, (status: string) => {
      expect(res?.status).toBe(Number(status));
    });

    and('o meu token antigo passa a receber 401', async () => {
      const me = await api('GET', '/api/auth/me', { token: requireUser(world).token });
      expect(me.status).toBe(401);
      expect(errorCode(me)).toBe('A0003');
    });

    and('não resta nenhum registro meu no banco do video-api', async () => {
      const userId = requireUser(world).id;
      const [counts] = await queryDb<{ users: string; videos: string; history: string }>(
        'fiapx_video',
        `SELECT (SELECT count(*) FROM users WHERE id = $1) AS users,
                (SELECT count(*) FROM videos WHERE user_id = $1) AS videos,
                (SELECT count(*) FROM video_status_history WHERE video_id = $2) AS history`,
        [userId, requireVideoId(world)],
      );
      expect(counts).toEqual({ users: '0', videos: '0', history: '0' });
    });

    and('não resta nenhum arquivo meu nos buckets', async () => {
      const prefix = `${requireUser(world).id}/`;
      await waitFor(
        async () =>
          (await listKeys(BUCKETS.raw, prefix)).length === 0 &&
          (await listKeys(BUCKETS.zips, prefix)).length === 0,
        { timeoutMs: 30_000, intervalMs: 1_000, description: `buckets vazios em ${prefix}` },
      );
    });

    and('as minhas notificações ficam anonimizadas no notification-service', async () => {
      // user.deleted: outbox → RabbitMQ → notification-service (eventual).
      const userId = requireUser(world).id;
      const rows = await waitFor(
        async () => {
          const found = await queryDb<{ recipient: string; payload: unknown }>(
            'fiapx_notification',
            'SELECT recipient, payload FROM notifications WHERE user_id = $1',
            [userId],
          );
          return found.length > 0 && found.every((row) => row.recipient === 'removido')
            ? found
            : undefined;
        },
        { timeoutMs: 60_000, intervalMs: 1_000, description: 'notificações anonimizadas' },
      );
      expect(rows.every((row) => JSON.stringify(row.payload) === '{}')).toBe(true);
    });
  });
});
