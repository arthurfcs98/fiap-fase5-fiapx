import { parseEvent } from '../envelope';
import {
  EVENT_FIXTURES,
  processingStartedFixture,
  userDeletedFixture,
  videoCompletedFixture,
  videoFailedFixture,
  videoUploadedFixture,
} from '../fixtures';
import { EVENT_SCHEMAS, fiapxEvent, isEventType, notificationEvent } from './event-registry';
import { EVENT_TYPES } from './event-types';

describe('registro de eventos v1', () => {
  it('EVENT_TYPES lista exatamente os types do contrato (seções 2 e 12)', () => {
    expect(Object.values(EVENT_TYPES)).toEqual([
      'video.uploaded',
      'video.processing.started',
      'video.processing.completed',
      'video.processing.failed',
      'video.failed',
      'video.completed',
      'user.deleted',
    ]);
  });

  it('tem um schema e uma fixture para cada type de EVENT_TYPES', () => {
    const types = Object.values(EVENT_TYPES);
    expect(Object.keys(EVENT_SCHEMAS).sort()).toEqual([...types].sort());
    expect(Object.keys(EVENT_FIXTURES).sort()).toEqual([...types].sort());
    for (const type of types) {
      expect(EVENT_SCHEMAS[type].parse(EVENT_FIXTURES[type])).toEqual(EVENT_FIXTURES[type]);
      expect(fiapxEvent.parse(EVENT_FIXTURES[type]).type).toBe(type);
      expect(EVENT_FIXTURES[type].type).toBe(type);
    }
  });

  it.each([
    ['video.uploaded', true],
    ['video.processing.failed', true],
    ['user.deleted', true],
    ['video.unknown', false],
    ['toString', false],
    [42, false],
    [undefined, false],
  ])('isEventType(%p) → %p', (value, expected) => {
    expect(isEventType(value)).toBe(expected);
  });

  it('notification.events aceita video.failed, video.completed e user.deleted', () => {
    expect(notificationEvent.parse(videoFailedFixture).type).toBe('video.failed');
    expect(notificationEvent.parse(videoCompletedFixture).type).toBe('video.completed');
    expect(notificationEvent.parse(userDeletedFixture).type).toBe('user.deleted');
    expect(parseEvent(notificationEvent, processingStartedFixture).success).toBe(false);
    expect(parseEvent(notificationEvent, videoUploadedFixture).success).toBe(false);
  });
});
