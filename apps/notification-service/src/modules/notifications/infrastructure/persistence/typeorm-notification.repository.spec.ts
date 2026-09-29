import type { DataSource } from 'typeorm';
import { LessThan, Not } from 'typeorm';
import type { DeliveryStep } from '../../domain/ports/notification.repository';
import { NotificationOrmEntity } from './notification.orm-entity';
import {
  INSERT_IF_ABSENT_SQL,
  RETENTION_LOCK_KEY,
  TypeOrmNotificationRepository,
  USER_LOCK_SQL,
} from './typeorm-notification.repository';

/**
 * Unit test with a fake DataSource: checks the calls (SQL, criteria, lock, updates). The real
 * SQL against Postgres is covered by `test/notification-service.int-spec.ts`.
 */
function fakeDataSource() {
  const repository = { findOne: jest.fn(), update: jest.fn() };
  const manager = { getRepository: jest.fn(() => repository), query: jest.fn() };
  const dataSource = {
    query: jest.fn(),
    getRepository: jest.fn(() => repository),
    transaction: jest.fn((work: (m: typeof manager) => Promise<unknown>) => work(manager)),
  };
  return {
    dataSource,
    manager,
    repository,
    subject: new TypeOrmNotificationRepository(dataSource as unknown as DataSource),
  };
}

function row(overrides: Partial<NotificationOrmEntity> = {}): NotificationOrmEntity {
  return Object.assign(new NotificationOrmEntity(), {
    id: '00000000-0000-4000-8000-000000000001',
    dedupKey: 'VIDEO_FAILED:v1',
    userId: '00000000-0000-4000-8000-0000000000aa',
    type: 'VIDEO_FAILED',
    recipient: 'ana@example.com',
    subject: 'assunto',
    status: 'PENDING',
    attempts: 0,
    providerMessageId: null,
    lastError: null,
    payload: { videoId: 'v1' },
    createdAt: new Date('2026-10-10T12:00:00Z'),
    sentAt: null,
    ...overrides,
  });
}

/** Evaluates the raw SQL expressions (`() => 'attempts + 1'`) of an update for assertions. */
function sqlOf(update: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(update).map(([key, value]) => [
      key,
      typeof value === 'function' ? `SQL(${String((value as () => string)())})` : value,
    ]),
  );
}

describe('TypeOrmNotificationRepository', () => {
  describe('registerIfAbsent', () => {
    const notification = {
      id: 'n1',
      dedupKey: 'VIDEO_FAILED:v1',
      userId: 'u1',
      type: 'VIDEO_FAILED' as const,
      recipient: 'ana@example.com',
      subject: 's',
      payload: { videoId: 'v1', userName: 'Ana' },
    };

    it('under the per-user lock: inserts unless the user was deleted (ON CONFLICT DO NOTHING)', async () => {
      const { manager, subject } = fakeDataSource();
      manager.query
        .mockResolvedValueOnce([]) // lock
        .mockResolvedValueOnce([{ id: 'n1' }]); // insert

      await expect(subject.registerIfAbsent(notification)).resolves.toBe('created');

      expect(manager.query).toHaveBeenNthCalledWith(1, USER_LOCK_SQL, ['u1']);
      expect(INSERT_IF_ABSENT_SQL).toContain('ON CONFLICT (dedup_key) DO NOTHING');
      expect(INSERT_IF_ABSENT_SQL).toContain('NOT EXISTS (SELECT 1 FROM deleted_users');
      expect(manager.query).toHaveBeenNthCalledWith(2, INSERT_IF_ABSENT_SQL, [
        'n1',
        'VIDEO_FAILED:v1',
        'u1',
        'VIDEO_FAILED',
        'ana@example.com',
        's',
        '{"videoId":"v1","userName":"Ana"}',
      ]);
    });

    it('tells a redelivery (row exists) from a deleted user', async () => {
      const { manager, subject } = fakeDataSource();
      manager.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ gone: false }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ gone: true }]);

      await expect(subject.registerIfAbsent(notification)).resolves.toBe('exists');
      await expect(subject.registerIfAbsent(notification)).resolves.toBe('user-deleted');
    });
  });

  describe('budget queries', () => {
    it('isRegistered checks the dedup key', async () => {
      const { dataSource, subject } = fakeDataSource();
      dataSource.query.mockResolvedValueOnce([{ found: true }]).mockResolvedValueOnce([]);

      await expect(subject.isRegistered('VIDEO_FAILED:v1')).resolves.toBe(true);
      await expect(subject.isRegistered('VIDEO_FAILED:v2')).resolves.toBe(false);
      expect(dataSource.query.mock.calls[0]?.[1]).toEqual(['VIDEO_FAILED:v1']);
    });

    it('countCreatedSince counts the user and everyone since the moment', async () => {
      const { dataSource, subject } = fakeDataSource();
      const since = new Date('2026-10-09T12:00:00Z');
      dataSource.query.mockResolvedValueOnce([{ user: 3, total: 40 }]).mockResolvedValueOnce([]);

      await expect(subject.countCreatedSince(since, 'u1')).resolves.toEqual({ user: 3, total: 40 });
      await expect(subject.countCreatedSince(since, 'u1')).resolves.toEqual({ user: 0, total: 0 });
      const [sql, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('FILTER (WHERE user_id = $2)');
      expect(params).toEqual([since, 'u1']);
    });
  });

  describe('deliverExclusively', () => {
    it('locks the row (FOR UPDATE), runs the attempt and persists SENT with attempts + 1', async () => {
      const { dataSource, repository, subject } = fakeDataSource();
      repository.findOne.mockResolvedValue(row());
      const attempt = jest.fn((): Promise<DeliveryStep<string>> =>
        Promise.resolve({
          record: { status: 'SENT', providerMessageId: `re_${'x'.repeat(150)}` },
          result: 'done',
        }),
      );

      await expect(subject.deliverExclusively('VIDEO_FAILED:v1', attempt)).resolves.toBe('done');

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { dedupKey: 'VIDEO_FAILED:v1' },
        lock: { mode: 'pessimistic_write' },
      });
      expect(attempt).toHaveBeenCalledWith(
        expect.objectContaining({ id: row().id, status: 'PENDING', recipient: 'ana@example.com' }),
      );
      const [criteria, update] = repository.update.mock.calls[0] as [
        unknown,
        Record<string, unknown>,
      ];
      expect(criteria).toEqual({ id: row().id });
      expect(sqlOf(update)).toEqual({
        status: 'SENT',
        attempts: 'SQL(attempts + 1)',
        providerMessageId: `re_${'x'.repeat(97)}`,
        lastError: null,
        sentAt: 'SQL(now())',
      });
    });

    it('persists FAILED/PENDING with the error (truncated) and counts only real attempts', async () => {
      const { repository, subject } = fakeDataSource();
      repository.findOne.mockResolvedValue(row());

      await subject.deliverExclusively('k', () =>
        Promise.resolve({
          record: { status: 'PENDING' as const, error: 'e'.repeat(600), attempted: true },
          result: undefined,
        }),
      );
      await subject.deliverExclusively('k', () =>
        Promise.resolve({
          record: { status: 'FAILED' as const, error: 'removed', attempted: false },
          result: undefined,
        }),
      );

      const updates = repository.update.mock.calls.map((call) =>
        sqlOf(call[1] as Record<string, unknown>),
      );
      expect(updates).toEqual([
        { status: 'PENDING', lastError: 'e'.repeat(500), attempts: 'SQL(attempts + 1)' },
        { status: 'FAILED', lastError: 'removed' },
      ]);
    });

    it('writes nothing when the attempt returns no record', async () => {
      const { repository, subject } = fakeDataSource();
      repository.findOne.mockResolvedValue(row({ status: 'SENT' }));

      await expect(
        subject.deliverExclusively('k', () => Promise.resolve({ result: 'duplicate' })),
      ).resolves.toBe('duplicate');
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('fails (and rolls back) when the row does not exist', async () => {
      const { repository, subject } = fakeDataSource();
      repository.findOne.mockResolvedValue(null);
      const attempt = jest.fn();

      await expect(subject.deliverExclusively('VIDEO_FAILED:v9', attempt)).rejects.toThrow(
        'Notification VIDEO_FAILED:v9 not found',
      );
      expect(attempt).not.toHaveBeenCalled();
    });
  });

  describe('anonymizeByUser', () => {
    it('records the deleted user and anonymizes its rows, in one transaction under the user lock', async () => {
      const { dataSource, manager, repository, subject } = fakeDataSource();
      repository.update.mockResolvedValueOnce({ affected: 2 }).mockResolvedValueOnce({});

      await expect(subject.anonymizeByUser('u1')).resolves.toBe(2);
      await expect(subject.anonymizeByUser('u1')).resolves.toBe(0);

      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
      expect(manager.query).toHaveBeenNthCalledWith(1, USER_LOCK_SQL, ['u1']);
      expect(manager.query).toHaveBeenNthCalledWith(
        2,
        'INSERT INTO deleted_users (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
        ['u1'],
      );
      expect(repository.update).toHaveBeenCalledWith(
        { userId: 'u1', recipient: Not('removido') },
        { recipient: 'removido', payload: {} },
      );
    });
  });

  describe('anonymizeCreatedBefore', () => {
    const cutoff = new Date('2026-09-01T00:00:00Z');

    it('takes the transaction advisory lock, then anonymizes rows older than the cutoff', async () => {
      const { manager, repository, subject } = fakeDataSource();
      manager.query.mockResolvedValue([{ locked: true }]);
      repository.update.mockResolvedValueOnce({ affected: 5 }).mockResolvedValueOnce({});

      await expect(subject.anonymizeCreatedBefore(cutoff)).resolves.toBe(5);
      await expect(subject.anonymizeCreatedBefore(cutoff)).resolves.toBe(0);

      expect(manager.query).toHaveBeenCalledWith('SELECT pg_try_advisory_xact_lock($1) AS locked', [
        RETENTION_LOCK_KEY,
      ]);
      expect(repository.update).toHaveBeenCalledWith(
        { createdAt: LessThan(cutoff), recipient: Not('removido') },
        { recipient: 'removido', payload: {} },
      );
      expect(manager.query).toHaveBeenCalledWith(
        'DELETE FROM deleted_users WHERE deleted_at < $1',
        [cutoff],
      );
    });

    it.each([[[{ locked: false }]], [[]]])(
      'returns null without touching rows when the lock is taken (%p)',
      async (lockRows) => {
        const { manager, repository, subject } = fakeDataSource();
        manager.query.mockResolvedValue(lockRows);

        await expect(subject.anonymizeCreatedBefore(cutoff)).resolves.toBeNull();
        expect(repository.update).not.toHaveBeenCalled();
      },
    );
  });
});
