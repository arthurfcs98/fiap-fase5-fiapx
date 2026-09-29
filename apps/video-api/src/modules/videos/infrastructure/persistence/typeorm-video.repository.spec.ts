import type { EntityManager } from 'typeorm';
import { In } from 'typeorm';
import { aVideo, NOW, USER_ID, VIDEO_ID } from '../../../../../test/support/fakes';
import {
  DuplicateIdempotencyKeyError,
  VideoOwnerNotFoundError,
} from '../../domain/video.repository';
import {
  TypeOrmVideoRepository,
  VIDEOS_IDEMPOTENCY_CONSTRAINT,
  VIDEOS_USER_FK_CONSTRAINT,
} from './typeorm-video.repository';
import { VideoStatusHistoryOrmEntity } from './video-status-history.orm-entity';
import { VideoOrmEntity } from './video.orm-entity';

function setup() {
  const videos = {
    insert: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn(),
    find: jest.fn(),
    findAndCount: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const history = {
    insert: jest.fn().mockResolvedValue(undefined),
    find: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const manager = {
    getRepository: jest.fn((entity: unknown) => (entity === VideoOrmEntity ? videos : history)),
    query: jest.fn(),
  };
  return {
    videos,
    history,
    manager,
    repo: new TypeOrmVideoRepository(manager as unknown as EntityManager),
  };
}

const row = (overrides: Partial<VideoOrmEntity> = {}) =>
  Object.assign(new VideoOrmEntity(), aVideo().toSnapshot(), overrides);

describe('TypeOrmVideoRepository', () => {
  it('inserts the full snapshot and translates constraint violations', async () => {
    const { videos, repo } = setup();
    await repo.insert(aVideo());
    expect(videos.insert).toHaveBeenCalledWith(
      expect.objectContaining({ id: VIDEO_ID, status: 'QUEUED' }),
    );

    videos.insert.mockRejectedValueOnce({
      code: '23505',
      constraint: VIDEOS_IDEMPOTENCY_CONSTRAINT,
    });
    await expect(repo.insert(aVideo())).rejects.toBeInstanceOf(DuplicateIdempotencyKeyError);
    videos.insert.mockRejectedValueOnce({ code: '23503', constraint: VIDEOS_USER_FK_CONSTRAINT });
    await expect(repo.insert(aVideo())).rejects.toBeInstanceOf(VideoOwnerNotFoundError);
    videos.insert.mockRejectedValueOnce(new Error('db down'));
    await expect(repo.insert(aVideo())).rejects.toThrow('db down');
  });

  it('updates every mutable column by id', async () => {
    const { videos, repo } = setup();
    await repo.update(aVideo({ status: 'COMPLETED', zipKey: 'z' }));
    const [criteria, changes] = videos.update.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(criteria).toEqual({ id: VIDEO_ID });
    expect(changes).toMatchObject({ status: 'COMPLETED', zipKey: 'z' });
    expect(changes).not.toHaveProperty('id');
  });

  it('finds by id, by owner, by idempotency key and locked', async () => {
    const { videos, repo } = setup();
    videos.findOne.mockResolvedValue(row());

    await expect(repo.findById(VIDEO_ID)).resolves.toMatchObject({ id: VIDEO_ID });
    await expect(repo.findOwnedBy(VIDEO_ID, USER_ID)).resolves.toMatchObject({ id: VIDEO_ID });
    await expect(repo.findByIdempotencyKey(USER_ID, 'k')).resolves.toMatchObject({ id: VIDEO_ID });
    await expect(repo.lockById(VIDEO_ID)).resolves.toMatchObject({ id: VIDEO_ID });

    expect(videos.findOne.mock.calls).toEqual([
      [{ where: { id: VIDEO_ID } }],
      [{ where: { id: VIDEO_ID, userId: USER_ID } }],
      [{ where: { userId: USER_ID, idempotencyKey: 'k' } }],
      [{ where: { id: VIDEO_ID }, lock: { mode: 'pessimistic_write' } }],
    ]);

    videos.findOne.mockResolvedValue(null);
    await expect(repo.findById(VIDEO_ID)).resolves.toBeNull();
  });

  it('lists by owner (newest first, optional status, offset pagination)', async () => {
    const { videos, repo } = setup();
    videos.findAndCount.mockResolvedValue([[row()], 7]);

    await expect(
      repo.listByOwner({ userId: USER_ID, page: 3, limit: 2, status: 'FAILED' }),
    ).resolves.toMatchObject({
      total: 7,
      items: [{ id: VIDEO_ID }],
    });
    expect(videos.findAndCount).toHaveBeenCalledWith({
      where: { userId: USER_ID, status: 'FAILED' },
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: 4,
      take: 2,
    });

    await repo.listByOwner({ userId: USER_ID, page: 1, limit: 20 });
    expect(videos.findAndCount).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { userId: USER_ID }, skip: 0 }),
    );

    videos.find.mockResolvedValue([row()]);
    await expect(repo.listAllByOwner(USER_ID)).resolves.toHaveLength(1);
  });

  it('appends and reads the history', async () => {
    const { history, manager, repo } = setup();
    await repo.appendHistory(VIDEO_ID, { from: 'QUEUED', to: 'PROCESSING', reason: 'r' }, NOW);
    expect(manager.getRepository).toHaveBeenCalledWith(VideoStatusHistoryOrmEntity);
    expect(history.insert).toHaveBeenCalledWith({
      videoId: VIDEO_ID,
      fromStatus: 'QUEUED',
      toStatus: 'PROCESSING',
      reason: 'r',
      createdAt: NOW,
    });

    await expect(repo.historyOf([])).resolves.toEqual([]);
    history.find.mockResolvedValue([
      Object.assign(new VideoStatusHistoryOrmEntity(), {
        id: '1',
        videoId: VIDEO_ID,
        fromStatus: null,
        toStatus: 'QUEUED',
        reason: 'Upload recebido',
        createdAt: NOW,
      }),
    ]);
    await expect(repo.historyOf([VIDEO_ID])).resolves.toEqual([
      {
        videoId: VIDEO_ID,
        fromStatus: null,
        toStatus: 'QUEUED',
        reason: 'Upload recebido',
        createdAt: NOW,
      },
    ]);
    expect(history.find).toHaveBeenCalledWith({
      where: { videoId: In([VIDEO_ID]) },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  });

  it('locks expired zips with SKIP LOCKED, then loads them', async () => {
    const { videos, manager, repo } = setup();
    manager.query.mockResolvedValueOnce([]);
    await expect(repo.lockExpiredZips(NOW, 10)).resolves.toEqual([]);

    manager.query.mockResolvedValueOnce([{ id: VIDEO_ID }]);
    videos.find.mockResolvedValue([row({ status: 'COMPLETED', zipKey: 'z' })]);
    await expect(repo.lockExpiredZips(NOW, 10)).resolves.toMatchObject([
      { id: VIDEO_ID, zipKey: 'z' },
    ]);

    const [sql, params] = manager.query.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("status = 'COMPLETED' AND zip_key IS NOT NULL AND expired_at IS NULL");
    expect(params).toEqual([NOW, 10]);
  });

  it('deletes history and videos of an owner (LGPD erasure)', async () => {
    const { videos, history, repo } = setup();
    videos.find.mockResolvedValueOnce([]);
    await expect(repo.deleteAllByOwner(USER_ID)).resolves.toEqual([]);
    expect(videos.delete).not.toHaveBeenCalled();

    videos.find.mockResolvedValueOnce([{ id: VIDEO_ID }]);
    await expect(repo.deleteAllByOwner(USER_ID)).resolves.toEqual([VIDEO_ID]);
    expect(history.delete).toHaveBeenCalledWith({ videoId: In([VIDEO_ID]) });
    expect(videos.delete).toHaveBeenCalledWith({ userId: USER_ID });
  });

  it('counts pending videos of an owner (QUEUED or PROCESSING)', async () => {
    const { manager, repo } = setup();
    manager.query.mockResolvedValueOnce([{ pending: 3 }]).mockResolvedValueOnce([]);

    await expect(repo.countPendingByOwner(USER_ID)).resolves.toBe(3);
    await expect(repo.countPendingByOwner(USER_ID)).resolves.toBe(0);

    const [sql, params] = manager.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status IN ('QUEUED', 'PROCESSING')");
    expect(params).toEqual([USER_ID]);
  });

  it('reads the status of the existing videos among the ids', async () => {
    const { manager, repo } = setup();
    await expect(repo.statusesOf([])).resolves.toEqual(new Map());
    expect(manager.query).not.toHaveBeenCalled();

    manager.query.mockResolvedValueOnce([{ id: VIDEO_ID, status: 'COMPLETED' }]);
    await expect(repo.statusesOf([VIDEO_ID, USER_ID])).resolves.toEqual(
      new Map([[VIDEO_ID, 'COMPLETED']]),
    );
    expect(manager.query.mock.calls[0]?.[1]).toEqual([[VIDEO_ID, USER_ID]]);
  });

  it('sums the bytes of the stored (not expired) zips', async () => {
    const { manager, repo } = setup();
    manager.query.mockResolvedValueOnce([{ bytes: '2147483648' }]).mockResolvedValueOnce([]);

    await expect(repo.sumStoredZipBytes()).resolves.toBe(2_147_483_648);
    await expect(repo.sumStoredZipBytes()).resolves.toBe(0);
    expect(manager.query.mock.calls[0]?.[0]).toContain(
      'zip_key IS NOT NULL AND expired_at IS NULL',
    );
  });
});
