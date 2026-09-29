import type { UserDeletedEvent } from '../events/user.events';
import { FIXTURE_CORRELATION_ID, FIXTURE_OCCURRED_AT, FIXTURE_USER_ID } from './fixture-ids';

export const userDeletedFixture: UserDeletedEvent = {
  id: '6d7e8f90-a1b2-4c3d-8e4f-5a6b7c8d9e0f',
  type: 'user.deleted',
  version: 1,
  occurredAt: FIXTURE_OCCURRED_AT,
  correlationId: FIXTURE_CORRELATION_ID,
  payload: { userId: FIXTURE_USER_ID },
};
