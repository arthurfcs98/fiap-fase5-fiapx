import { parseEvent } from '../envelope';
import { FIXTURE_USER_ID, userDeletedFixture, videoFailedFixture } from '../fixtures';
import { createEvent } from './create-event';
import { EVENT_TYPES } from './event-types';
import { userDeletedEvent } from './user.events';

describe('evento user.deleted v1 (contratos.md, seção 12)', () => {
  it('a fixture é válida, o type é a routing key e o payload só tem o userId', () => {
    expect(userDeletedEvent.parse(userDeletedFixture)).toEqual(userDeletedFixture);
    expect(userDeletedFixture.type).toBe(EVENT_TYPES.userDeleted);
    expect(EVENT_TYPES.userDeleted).toBe('user.deleted');
    expect(userDeletedFixture.payload).toEqual({ userId: FIXTURE_USER_ID });
    // Mesmo usuário das fixtures de vídeo: os testes de anonimização cruzam as duas.
    expect(userDeletedFixture.payload.userId).toBe(videoFailedFixture.payload.userId);
  });

  it.each([
    ['userId não-UUID', { userId: '123' }],
    ['sem userId', {}],
  ])('rejeita %s', (_caso, payload) => {
    expect(parseEvent(userDeletedEvent, { ...userDeletedFixture, payload }).success).toBe(false);
  });

  it('descarta dados pessoais enviados por engano (só o userId sai validado)', () => {
    const withLeak = {
      ...userDeletedFixture,
      payload: { userId: FIXTURE_USER_ID, email: 'arthur@example.com', name: 'Arthur' },
    };

    const parsed = parseEvent(userDeletedEvent, withLeak);

    expect(parsed).toEqual({ success: true, event: userDeletedFixture });
  });

  it('createEvent monta o envelope tipado de user.deleted', () => {
    const event = createEvent('user.deleted', { userId: FIXTURE_USER_ID }, 'cid-lgpd');
    expect(userDeletedEvent.parse(event)).toEqual(event);
    expect(event).toMatchObject({ type: 'user.deleted', correlationId: 'cid-lgpd' });
  });
});
