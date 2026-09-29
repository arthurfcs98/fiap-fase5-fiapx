import { randomUUID } from 'node:crypto';
import type { DefineStepFunction } from 'jest-cucumber';
import type { ApiResponse, TestUser, UploadedVideo, VideoDetail } from './api';
import { createUser, uploadFixture, uploadProcessedVideo, waitForTerminal } from './api';
import { rawObjectsOf } from './storage';

/** State of one scenario (a fresh object per scenario). */
export interface World {
  user?: TestUser;
  upload?: ApiResponse<UploadedVideo>;
  video?: VideoDetail;
  correlationId?: string;
}

export function requireUser(world: World): TestUser {
  if (!world.user) throw new Error('cenário sem usuário autenticado');
  return world.user;
}

export function requireVideoId(world: World): string {
  const id = world.video?.id ?? world.upload?.body.id;
  if (!id) throw new Error('cenário sem vídeo enviado');
  return id;
}

/** Correlation id unique to this run, accepted by the API (`[A-Za-z0-9._:-]{1,100}`). */
export function newCorrelationId(prefix: string): string {
  return `bdd-${prefix}-${randomUUID()}`;
}

// ------------------------------------------------------------ reusable steps --

export function givenAuthenticatedUser(given: DefineStepFunction, world: World): void {
  given('que estou cadastrado e autenticado', async () => {
    world.user = await createUser();
  });
}

export function givenProcessedVideo(given: DefineStepFunction, world: World): void {
  given('que enviei um vídeo que já foi processado', async () => {
    world.video = await uploadProcessedVideo(requireUser(world));
  });
}

export function whenUploadCorruptWithCorrelation(when: DefineStepFunction, world: World): void {
  when(
    /^envio o vídeo corrompido "(.*)" com um correlation id próprio$/,
    async (fixture: string) => {
      world.correlationId = newCorrelationId('corrupt');
      world.upload = await uploadFixture(requireUser(world).token, fixture, {
        correlationId: world.correlationId,
      });
    },
  );
}

export function thenAcceptedQueued(then: DefineStepFunction, world: World): void {
  then(
    /^a API aceita o envio com status (\d+) e o vídeo fica "(.*)"$/,
    (status: string, videoStatus: string) => {
      expect(world.upload?.status).toBe(Number(status));
      expect(world.upload?.body.status).toBe(videoStatus);
      expect(world.upload?.body.id).toMatch(/^[0-9a-f-]{36}$/);
    },
  );
}

/** Waits for the terminal state; used by several features with slightly different wording. */
export async function waitUploadedVideo(world: World): Promise<VideoDetail> {
  world.video = await waitForTerminal(requireUser(world).token, requireVideoId(world));
  return world.video;
}

export function thenRawDeleted(and: DefineStepFunction, world: World): void {
  and('o vídeo original é apagado do storage', async () => {
    // The API deletes the raw object right after COMPLETED/FAILED (contratos.md, section 12).
    const userId = requireUser(world).id;
    const videoId = requireVideoId(world);
    const deadline = Date.now() + 15_000;
    let keys = await rawObjectsOf(userId, videoId);
    while (keys.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      keys = await rawObjectsOf(userId, videoId);
    }
    expect(keys).toEqual([]);
  });
}
