import { DependencyUnavailableError, RetryableError } from '@fiapx/common';
import { videoCompletedFixture, videoFailedFixture } from '@fiapx/contracts/fixtures';
import { Logger } from '@nestjs/common';
import { EmailRejectedError } from '../../domain/email-rejected.error';
import type { DeliveryRecord, NewNotification, Notification } from '../../domain/notification';
import type { EmailMessage, EmailReceipt, EmailSender } from '../../domain/ports/email-sender.port';
import type {
  INotificationMetrics,
  NotificationOutcome,
} from '../../domain/ports/notification-metrics.port';
import type {
  DeliveryStep,
  INotificationRepository,
  NotificationCounts,
  RegisterOutcome,
} from '../../domain/ports/notification.repository';
import type { NotificationSettings } from '../notification.settings';
import type { VideoNotificationCommand } from './send-video-notification.use-case';
import {
  RECIPIENT_REMOVED_ERROR,
  SendVideoNotificationUseCase,
} from './send-video-notification.use-case';

/** In-memory repository with the same contract (the SQL is covered by the integration test). */
class FakeNotificationRepository implements INotificationRepository {
  readonly rows = new Map<string, Notification>();
  readonly deletedUsers = new Set<string>();
  /** Notifications of other users/videos in the last 24 h (budget). */
  extraCounts: NotificationCounts = { user: 0, total: 0 };
  registerFailure?: Error;

  isRegistered(dedupKey: string): Promise<boolean> {
    return Promise.resolve(this.rows.has(dedupKey));
  }

  countCreatedSince(_since: Date, userId: string): Promise<NotificationCounts> {
    const rows = [...this.rows.values()];
    return Promise.resolve({
      user: this.extraCounts.user + rows.filter((row) => row.userId === userId).length,
      total: this.extraCounts.total + rows.length,
    });
  }

  registerIfAbsent(notification: NewNotification): Promise<RegisterOutcome> {
    if (this.registerFailure) return Promise.reject(this.registerFailure);
    if (this.rows.has(notification.dedupKey)) return Promise.resolve('exists');
    if (this.deletedUsers.has(notification.userId)) return Promise.resolve('user-deleted');
    this.rows.set(notification.dedupKey, {
      ...notification,
      status: 'PENDING',
      attempts: 0,
      providerMessageId: null,
      lastError: null,
      createdAt: new Date(),
      sentAt: null,
    });
    return Promise.resolve('created');
  }

  async deliverExclusively<T>(
    dedupKey: string,
    attempt: (notification: Notification) => Promise<DeliveryStep<T>>,
  ): Promise<T> {
    const row = this.rows.get(dedupKey);
    if (!row) throw new Error(`Notification ${dedupKey} not found`);
    const { record, result } = await attempt({ ...row });
    if (record) this.apply(row, record);
    return result;
  }

  anonymizeByUser(): Promise<number> {
    return Promise.resolve(0);
  }

  anonymizeCreatedBefore(): Promise<number | null> {
    return Promise.resolve(0);
  }

  only(): Notification {
    expect(this.rows.size).toBe(1);
    return [...this.rows.values()][0];
  }

  private apply(row: Notification, record: DeliveryRecord): void {
    if (record.status === 'SENT') {
      Object.assign(row, {
        status: 'SENT',
        attempts: row.attempts + 1,
        providerMessageId: record.providerMessageId,
        lastError: null,
        sentAt: new Date(),
      });
      return;
    }
    Object.assign(row, {
      status: record.status,
      lastError: record.error,
      attempts: row.attempts + (record.attempted ? 1 : 0),
    });
  }
}

class FakeSender implements EmailSender {
  readonly provider = 'fake';
  readonly sent: EmailMessage[] = [];
  private failures: Error[] = [];

  failNext(...errors: Error[]): this {
    this.failures.push(...errors);
    return this;
  }

  send(message: EmailMessage): Promise<EmailReceipt> {
    const failure = this.failures.shift();
    if (failure !== undefined) return Promise.reject(failure);
    this.sent.push(message);
    return Promise.resolve({ providerMessageId: `fake-${this.sent.length}` });
  }
}

class FakeMetrics implements INotificationMetrics {
  readonly recorded: string[] = [];

  record(type: string, outcome: NotificationOutcome): void {
    this.recorded.push(`${type}:${outcome}`);
  }
}

const SETTINGS: NotificationSettings = {
  publicBaseUrl: 'https://fiapx.asdevit.com',
  notifyOnSuccess: true,
  retentionDays: 30,
  dailyLimitPerUser: 10,
  dailyLimit: 80,
};

const FAILED: VideoNotificationCommand = {
  type: 'VIDEO_FAILED',
  payload: videoFailedFixture.payload,
  correlationId: videoFailedFixture.correlationId,
  finalAttempt: false,
};

const COMPLETED: VideoNotificationCommand = {
  type: 'VIDEO_COMPLETED',
  payload: videoCompletedFixture.payload,
  correlationId: videoCompletedFixture.correlationId,
  finalAttempt: false,
};

const EMAIL = videoFailedFixture.payload.userEmail;
const DEDUP_KEY = `VIDEO_FAILED:${videoFailedFixture.payload.videoId}`;

describe('SendVideoNotificationUseCase', () => {
  let repository: FakeNotificationRepository;
  let sender: FakeSender;
  let metrics: FakeMetrics;
  let logged: unknown[][];

  function useCase(settings: NotificationSettings = SETTINGS): SendVideoNotificationUseCase {
    return new SendVideoNotificationUseCase(repository, sender, metrics, settings);
  }

  beforeEach(() => {
    repository = new FakeNotificationRepository();
    sender = new FakeSender();
    metrics = new FakeMetrics();
    logged = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
  });

  afterEach(() => {
    // LGPD: logs carry ids only, never the address, the user's name or the file name.
    const text = JSON.stringify(logged);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(videoFailedFixture.payload.userName);
    expect(text).not.toContain(videoFailedFixture.payload.originalName);
  });

  it('registers the notification, sends it with the id as idempotency key and marks it SENT', async () => {
    await expect(useCase().execute(FAILED)).resolves.toBe('SENT');

    const row = repository.only();
    expect(row).toMatchObject({
      dedupKey: DEDUP_KEY,
      userId: videoFailedFixture.payload.userId,
      type: 'VIDEO_FAILED',
      recipient: EMAIL,
      subject: 'FIAP Frames: não foi possível processar o seu vídeo',
      status: 'SENT',
      attempts: 1,
      providerMessageId: 'fake-1',
      lastError: null,
      payload: {
        videoId: videoFailedFixture.payload.videoId,
        userName: videoFailedFixture.payload.userName,
        originalName: videoFailedFixture.payload.originalName,
        errorCode: 'P0001',
        errorMessage: videoFailedFixture.payload.errorMessage,
      },
    });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.payload).not.toHaveProperty('userEmail');
    expect(sender.sent).toEqual([
      expect.objectContaining({
        idempotencyKey: row.id,
        to: EMAIL,
        subject: row.subject,
        correlationId: videoFailedFixture.correlationId,
      }),
    ]);
    expect(sender.sent[0]?.html).toContain('P0001');
    expect(metrics.recorded).toEqual(['VIDEO_FAILED:SENT']);
    expect(logged).toContainEqual([
      expect.objectContaining({
        msg: 'E-mail sent',
        notificationId: row.id,
        videoId: videoFailedFixture.payload.videoId,
        userId: videoFailedFixture.payload.userId,
        provider: 'fake',
      }),
    ]);
  });

  it('sends the success e-mail when NOTIFY_ON_SUCCESS=true', async () => {
    await expect(useCase().execute(COMPLETED)).resolves.toBe('SENT');

    expect(repository.only()).toMatchObject({
      dedupKey: `VIDEO_COMPLETED:${videoCompletedFixture.payload.videoId}`,
      type: 'VIDEO_COMPLETED',
      payload: { videoId: videoCompletedFixture.payload.videoId, frameCount: 3 },
    });
    expect(sender.sent[0]?.text).toContain('3 frames extraídos');
    expect(metrics.recorded).toEqual(['VIDEO_COMPLETED:SENT']);
  });

  it('skips the success e-mail when NOTIFY_ON_SUCCESS=false (nothing registered)', async () => {
    await expect(useCase({ ...SETTINGS, notifyOnSuccess: false }).execute(COMPLETED)).resolves.toBe(
      'DISABLED',
    );

    expect(repository.rows.size).toBe(0);
    expect(sender.sent).toHaveLength(0);
    expect(metrics.recorded).toEqual(['VIDEO_COMPLETED:SKIPPED']);
  });

  it('always sends the failure e-mail, even with NOTIFY_ON_SUCCESS=false', async () => {
    await expect(useCase({ ...SETTINGS, notifyOnSuccess: false }).execute(FAILED)).resolves.toBe(
      'SENT',
    );
  });

  it('does not send twice for a duplicate event (same dedup key)', async () => {
    await useCase().execute(FAILED);
    await expect(useCase().execute(FAILED)).resolves.toBe('DUPLICATE');

    expect(sender.sent).toHaveLength(1);
    expect(repository.only()).toMatchObject({ status: 'SENT', attempts: 1 });
    expect(metrics.recorded).toEqual(['VIDEO_FAILED:SENT', 'VIDEO_FAILED:SKIPPED']);
  });

  it('marks FAILED and acks (no throw) when the provider rejects the e-mail', async () => {
    sender.failNext(new EmailRejectedError('fake', '550 <arthur@example.com>: no such user'));

    await expect(useCase().execute(FAILED)).resolves.toBe('REJECTED');

    expect(repository.only()).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: 'fake rejected the e-mail: 550 <[email]>: no such user',
    });
    expect(metrics.recorded).toEqual(['VIDEO_FAILED:FAILED']);
  });

  it('keeps it PENDING and throws RetryableError on a transient failure (Fase 4 bug fixed)', async () => {
    sender.failNext(new RetryableError('SMTP 451: try later for arthur@example.com'));

    const failure = useCase().execute(FAILED);

    await expect(failure).rejects.toThrow(RetryableError);
    await expect(failure).rejects.toThrow('SMTP 451: try later for [email]');
    expect(repository.only()).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'SMTP 451: try later for [email]',
    });
    expect(metrics.recorded).toEqual(['VIDEO_FAILED:RETRY']);
  });

  it('treats an unknown sender error as transient, with a redacted reason', async () => {
    sender.failNext(new TypeError('socket hang up while talking to arthur@example.com'));

    await expect(useCase().execute(FAILED)).rejects.toThrow(
      'TypeError: socket hang up while talking to [email]',
    );
    expect(repository.only()).toMatchObject({ status: 'PENDING', attempts: 1 });
  });

  it('marks FAILED before the message goes to the DLQ on the last attempt', async () => {
    sender.failNext(new RetryableError('Resend rate_limit_exceeded (429)'));

    await expect(useCase().execute({ ...FAILED, finalAttempt: true })).rejects.toThrow(
      RetryableError,
    );

    expect(repository.only()).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: 'Retries exhausted: Resend rate_limit_exceeded (429)',
    });
    expect(metrics.recorded).toEqual(['VIDEO_FAILED:FAILED']);
  });

  it('sends on the retry after a transient failure (attempts counts both)', async () => {
    sender.failNext(new RetryableError('timeout'));
    await expect(useCase().execute(FAILED)).rejects.toThrow(RetryableError);

    await expect(useCase().execute(FAILED)).resolves.toBe('SENT');

    expect(repository.only()).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });
    expect(sender.sent).toHaveLength(1);
    expect(metrics.recorded).toEqual(['VIDEO_FAILED:RETRY', 'VIDEO_FAILED:SENT']);
  });

  it('tries again when a FAILED notification is redelivered (DLQ redrive)', async () => {
    sender.failNext(new RetryableError('down'));
    await expect(useCase().execute({ ...FAILED, finalAttempt: true })).rejects.toThrow();
    expect(repository.only().status).toBe('FAILED');

    await expect(useCase().execute(FAILED)).resolves.toBe('SENT');
    expect(repository.only()).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('never e-mails an anonymized recipient (user deleted while the e-mail was pending)', async () => {
    sender.failNext(new RetryableError('down'));
    await expect(useCase().execute(FAILED)).rejects.toThrow();
    const row = repository.only();
    Object.assign(row, { recipient: 'removido', payload: {} });

    await expect(useCase().execute(FAILED)).resolves.toBe('RECIPIENT_REMOVED');

    expect(sender.sent).toHaveLength(0);
    expect(row).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: RECIPIENT_REMOVED_ERROR,
    });
    expect(metrics.recorded).toEqual(['VIDEO_FAILED:RETRY', 'VIDEO_FAILED:SKIPPED']);

    // Already FAILED: nothing else is written.
    row.lastError = 'unchanged';
    await expect(useCase().execute(FAILED)).resolves.toBe('RECIPIENT_REMOVED');
    expect(row.lastError).toBe('unchanged');
  });

  it('sends to the recipient stored in the row', async () => {
    await repository.registerIfAbsent({
      id: '00000000-0000-4000-8000-000000000001',
      dedupKey: DEDUP_KEY,
      userId: videoFailedFixture.payload.userId,
      type: 'VIDEO_FAILED',
      recipient: 'registered-first@example.com',
      subject: 's',
      payload: {},
    });

    await useCase().execute(FAILED);

    expect(sender.sent[0]).toMatchObject({
      to: 'registered-first@example.com',
      idempotencyKey: '00000000-0000-4000-8000-000000000001',
    });
  });

  it('propagates repository failures (the consumer turns them into a retry)', async () => {
    repository.registerFailure = new Error('connection terminated');

    await expect(useCase().execute(FAILED)).rejects.toThrow('connection terminated');
    expect(sender.sent).toHaveLength(0);
    expect(metrics.recorded).toEqual([]);
  });

  describe('e-mail budget (unverified sign-up addresses: anti-abuse)', () => {
    it('skips a NEW notification beyond the per-user daily limit (nothing stored)', async () => {
      repository.extraCounts = { user: 10, total: 10 };

      await expect(useCase().execute(FAILED)).resolves.toBe('BUDGET_EXCEEDED');

      expect(repository.rows.size).toBe(0);
      expect(sender.sent).toHaveLength(0);
      expect(metrics.recorded).toEqual(['VIDEO_FAILED:SKIPPED']);
      expect(logged).toContainEqual([expect.objectContaining({ scope: 'user' })]);
    });

    it('skips beyond the global daily limit, below the provider quota', async () => {
      repository.extraCounts = { user: 0, total: 80 };

      await expect(useCase().execute(FAILED)).resolves.toBe('BUDGET_EXCEEDED');
      expect(logged).toContainEqual([expect.objectContaining({ scope: 'global' })]);
    });

    it('a redelivery of an already registered notification is not blocked by the budget', async () => {
      sender.failNext(new RetryableError('timeout'));
      await expect(useCase().execute(FAILED)).rejects.toThrow(RetryableError);
      repository.extraCounts = { user: 50, total: 500 };

      await expect(useCase().execute(FAILED)).resolves.toBe('SENT');
    });
  });

  it('never stores nor sends for a user already deleted (user.deleted consumed first)', async () => {
    repository.deletedUsers.add(videoFailedFixture.payload.userId);

    await expect(useCase().execute(FAILED)).resolves.toBe('RECIPIENT_REMOVED');

    expect(repository.rows.size).toBe(0);
    expect(sender.sent).toHaveLength(0);
    expect(metrics.recorded).toEqual(['VIDEO_FAILED:SKIPPED']);
  });

  it('provider outage: stays PENDING even on the "last" attempt and pauses the consumer', async () => {
    sender.failNext(new DependencyUnavailableError('resend', { detail: 'rate_limit (429)' }));

    const failure = useCase().execute({ ...FAILED, finalAttempt: true });

    await expect(failure).rejects.toBeInstanceOf(DependencyUnavailableError);
    expect(repository.only()).toMatchObject({
      status: 'PENDING',
      lastError: 'DEPENDENCY_UNAVAILABLE (resend): rate_limit (429)',
    });
    expect(metrics.recorded).toEqual(['VIDEO_FAILED:RETRY']);
  });
});
