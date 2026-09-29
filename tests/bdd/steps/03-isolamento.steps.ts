import { defineFeature, loadFeature } from 'jest-cucumber';
import type { TestUser } from '../support/api';
import { api, createUser, errorCode, uploadFixture } from '../support/api';

const feature = loadFeature('tests/bdd/features/03-isolamento.feature');

defineFeature(feature, (test) => {
  test('usuário não vê vídeos de outro usuário', ({ given, when, then, and }) => {
    const users = new Map<string, TestUser>();
    const videos = new Map<string, string>();
    let lastStatus = 0;
    let lastCode: string | undefined;
    const user = (name: string): TestUser => {
      const found = users.get(name);
      if (!found) throw new Error(`usuário ${name} não criado`);
      return found;
    };

    given(/^que a usuária "(.*)" enviou um vídeo$/, async (name: string) => {
      users.set(name, await createUser());
      const upload = await uploadFixture(user(name).token, 'sample-ok-5s.mp4');
      expect(upload.status).toBe(202);
      videos.set(name, upload.body.id);
    });

    and(/^que o usuário "(.*)" está autenticado$/, async (name: string) => {
      users.set(name, await createUser());
    });

    when(/^"(.*)" consulta o vídeo de "(.*)"$/, async (who: string, owner: string) => {
      const res = await api('GET', `/api/videos/${videos.get(owner)}`, { token: user(who).token });
      lastStatus = res.status;
      lastCode = errorCode(res);
    });

    then(
      /^"(.*)" recebe (\d+) com o código "(.*)"$/,
      (_who: string, status: string, code: string) => {
        // 404 (not 403): the API does not even reveal that the video exists.
        expect(lastStatus).toBe(Number(status));
        expect(lastCode).toBe(code);
      },
    );

    and(
      /^"(.*)" também recebe (\d+) ao pedir o link de download do vídeo de "(.*)"$/,
      async (who: string, status: string, owner: string) => {
        const res = await api('POST', `/api/videos/${videos.get(owner)}/download-url`, {
          token: user(who).token,
        });
        expect(res.status).toBe(Number(status));
        expect(errorCode(res)).toBe('V0001');
      },
    );

    and(
      /^a lista de vídeos de "(.*)" não mostra o vídeo de "(.*)"$/,
      async (who: string, owner: string) => {
        const res = await api<{ items: Array<{ id: string }>; total: number }>(
          'GET',
          '/api/videos',
          {
            token: user(who).token,
          },
        );
        expect(res.status).toBe(200);
        expect(res.body.items.map((item) => item.id)).not.toContain(videos.get(owner));
        expect(res.body.total).toBe(0);
      },
    );
  });

  test('requisição sem token recebe 401', ({ when, then, and }) => {
    let status = 0;
    let code: string | undefined;

    when('consulto a lista de vídeos sem token', async () => {
      const res = await api('GET', '/api/videos');
      status = res.status;
      code = errorCode(res);
    });

    then(/^recebo (\d+) com o código "(.*)"$/, (expected: string, expectedCode: string) => {
      expect(status).toBe(Number(expected));
      expect(code).toBe(expectedCode);
    });

    and('enviar um vídeo sem token também recebe 401', async () => {
      const res = await uploadFixture(undefined, 'sample-ok-5s.mp4');
      expect(res.status).toBe(401);
      expect(errorCode(res)).toBe('A0003');
    });

    and('um token adulterado também recebe 401', async () => {
      const owner = await createUser();
      const [header, payload] = owner.token.split('.');
      const forged = `${header}.${payload}.assinatura-falsa`;
      const res = await api('GET', '/api/videos', { token: forged });
      expect(res.status).toBe(401);
      expect(errorCode(res)).toBe('A0003');
    });
  });
});
