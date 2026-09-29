import {
  ANONYMIZED_RECIPIENT,
  isAnonymized,
  isNotificationStatus,
  isNotificationType,
  notificationDedupKey,
} from './notification';

describe('notification (domain)', () => {
  it('builds the dedup key as <TYPE>:<videoId> (contratos.md, section 6)', () => {
    expect(notificationDedupKey('VIDEO_FAILED', '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b')).toBe(
      'VIDEO_FAILED:6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b',
    );
  });

  it('recognizes an anonymized recipient', () => {
    expect(ANONYMIZED_RECIPIENT).toBe('removido');
    expect(isAnonymized({ recipient: 'removido' })).toBe(true);
    expect(isAnonymized({ recipient: 'ana@example.com' })).toBe(false);
  });

  it.each([
    ['VIDEO_FAILED', true],
    ['VIDEO_COMPLETED', true],
    ['VERIFY_EMAIL', false],
    [undefined, false],
  ])('isNotificationType(%p) → %p', (value, expected) => {
    expect(isNotificationType(value)).toBe(expected);
  });

  it.each([
    ['PENDING', true],
    ['SENT', true],
    ['FAILED', true],
    ['DEFERRED', false],
    [42, false],
  ])('isNotificationStatus(%p) → %p', (value, expected) => {
    expect(isNotificationStatus(value)).toBe(expected);
  });
});
