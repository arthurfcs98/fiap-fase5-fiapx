import {
  aVideo,
  InMemoryVideoRepository,
  NOW,
  OTHER_USER_ID,
  USER_ID,
  VIDEO_ID,
} from '../../../../../test/support/fakes';
import { GetVideoUseCase } from './get-video.use-case';
import { ListVideosUseCase } from './list-videos.use-case';

const SECOND = '7a1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4c';

function repository() {
  const videos = new InMemoryVideoRepository();
  videos.add(aVideo());
  videos.add(
    aVideo({
      id: SECOND,
      status: 'COMPLETED',
      zipKey: 'z.zip',
      createdAt: new Date(NOW.getTime() + 1000),
    }),
  );
  videos.add(aVideo({ id: '8a1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4d', userId: OTHER_USER_ID }));
  return videos;
}

describe('ListVideosUseCase', () => {
  it('lists only the user videos, newest first, with the page info', async () => {
    const page = await new ListVideosUseCase(repository()).execute({
      userId: USER_ID,
      page: 1,
      limit: 20,
    });
    expect(page).toMatchObject({ total: 2, page: 1, limit: 20 });
    expect(page.items.map((item) => item.id)).toEqual([SECOND, VIDEO_ID]);
    expect(page.items[0]).toMatchObject({ status: 'COMPLETED', downloadAvailable: true });
    expect(page.items[0]).not.toHaveProperty('rawKey');
  });

  it('filters by status and paginates', async () => {
    const useCase = new ListVideosUseCase(repository());
    await expect(
      useCase.execute({ userId: USER_ID, page: 1, limit: 20, status: 'QUEUED' }),
    ).resolves.toMatchObject({ total: 1, items: [{ id: VIDEO_ID }] });
    await expect(useCase.execute({ userId: USER_ID, page: 2, limit: 1 })).resolves.toMatchObject({
      total: 2,
      items: [{ id: VIDEO_ID }],
    });
  });
});

describe('GetVideoUseCase', () => {
  it('returns the detail with the history', async () => {
    const videos = repository();
    await videos.appendHistory(
      VIDEO_ID,
      { from: null, to: 'QUEUED', reason: 'Upload recebido' },
      NOW,
    );

    await expect(new GetVideoUseCase(videos).execute(USER_ID, VIDEO_ID)).resolves.toMatchObject({
      id: VIDEO_ID,
      status: 'QUEUED',
      history: [
        {
          fromStatus: null,
          toStatus: 'QUEUED',
          reason: 'Upload recebido',
          createdAt: NOW.toISOString(),
        },
      ],
    });
  });

  it.each([
    ['another user video', OTHER_USER_ID, VIDEO_ID],
    ['a missing video', USER_ID, '00000000-0000-4000-8000-000000000000'],
    ['a malformed id', USER_ID, 'abc'],
  ])('%s → 404 V0001', async (_case, userId, id) => {
    await expect(new GetVideoUseCase(repository()).execute(userId, id)).rejects.toMatchObject({
      appError: { code: 'V0001', httpStatus: 404 },
    });
  });
});
