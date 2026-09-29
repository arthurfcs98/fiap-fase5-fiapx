import {
  aUser,
  aVideo,
  FixedClock,
  InMemoryUserRepository,
  InMemoryVideoRepository,
  NOW,
  OTHER_USER_ID,
  USER_ID,
  VIDEO_ID,
} from '../../../../../test/support/fakes';
import { ExportMyDataUseCase } from './export-my-data.use-case';

describe('ExportMyDataUseCase (LGPD art. 18 II and V)', () => {
  it('exports the user (without the hash), every video and its history', async () => {
    const users = new InMemoryUserRepository();
    users.users.set(USER_ID, aUser());
    const videos = new InMemoryVideoRepository();
    videos.add(aVideo());
    videos.add(aVideo({ id: '8a1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4d', userId: OTHER_USER_ID }));
    await videos.appendHistory(
      VIDEO_ID,
      { from: null, to: 'QUEUED', reason: 'Upload recebido' },
      NOW,
    );
    await videos.appendHistory(
      '8a1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4d',
      { from: null, to: 'QUEUED', reason: 'x' },
      NOW,
    );

    const data = await new ExportMyDataUseCase(users, videos, new FixedClock()).execute(USER_ID);

    expect(data).toEqual({
      exportedAt: NOW.toISOString(),
      user: {
        id: USER_ID,
        name: 'Ana Souza',
        email: 'ana@example.com',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        privacyAcceptedAt: NOW.toISOString(),
        privacyPolicyVersion: '2026-09-28',
      },
      videos: [
        expect.objectContaining({
          id: VIDEO_ID,
          originalName: 'demo.mp4',
          history: [
            {
              fromStatus: null,
              toStatus: 'QUEUED',
              reason: 'Upload recebido',
              createdAt: NOW.toISOString(),
            },
          ],
        }),
      ],
    });
    expect(JSON.stringify(data)).not.toContain('hash:');
  });

  it('deleted user → 401 A0003', async () => {
    await expect(
      new ExportMyDataUseCase(
        new InMemoryUserRepository(),
        new InMemoryVideoRepository(),
        new FixedClock(),
      ).execute(USER_ID),
    ).rejects.toMatchObject({ appError: { code: 'A0003' } });
  });
});
