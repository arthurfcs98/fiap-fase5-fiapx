import { toDomainNotification } from './notification.mapper';
import { NotificationOrmEntity } from './notification.orm-entity';

function row(overrides: Partial<NotificationOrmEntity> = {}): NotificationOrmEntity {
  return Object.assign(new NotificationOrmEntity(), {
    id: 'n1',
    dedupKey: 'VIDEO_COMPLETED:v1',
    userId: 'u1',
    type: 'VIDEO_COMPLETED',
    recipient: 'removido',
    subject: 's',
    status: 'SENT',
    attempts: 2,
    providerMessageId: 're_1',
    lastError: null,
    payload: {},
    createdAt: new Date(0),
    sentAt: new Date(1),
    ...overrides,
  });
}

describe('toDomainNotification', () => {
  it('maps every field', () => {
    expect(toDomainNotification(row())).toEqual({
      id: 'n1',
      dedupKey: 'VIDEO_COMPLETED:v1',
      userId: 'u1',
      type: 'VIDEO_COMPLETED',
      recipient: 'removido',
      subject: 's',
      status: 'SENT',
      attempts: 2,
      providerMessageId: 're_1',
      lastError: null,
      payload: {},
      createdAt: new Date(0),
      sentAt: new Date(1),
    });
  });

  it('fails loudly on an unknown type or status', () => {
    expect(() => toDomainNotification(row({ type: 'VERIFY_EMAIL' }))).toThrow(
      'Notification n1 has an unknown type "VERIFY_EMAIL"',
    );
    expect(() => toDomainNotification(row({ status: 'DEFERRED' }))).toThrow(
      'Notification n1 has an unknown status "DEFERRED"',
    );
  });
});
