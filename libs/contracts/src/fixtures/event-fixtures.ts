import type { FiapxEvent } from '../events/event-registry';
import type { EventType } from '../events/event-types';
import { userDeletedFixture } from './user.fixtures';
import {
  processingCompletedFixture,
  processingFailedFixture,
  processingStartedFixture,
  videoCompletedFixture,
  videoFailedFixture,
  videoUploadedFixture,
} from './video.fixtures';

/** Uma fixture v1 por `type` (útil para testes parametrizados de produtor/consumidor). */
export const EVENT_FIXTURES = {
  'video.uploaded': videoUploadedFixture,
  'video.processing.started': processingStartedFixture,
  'video.processing.completed': processingCompletedFixture,
  'video.processing.failed': processingFailedFixture,
  'video.failed': videoFailedFixture,
  'video.completed': videoCompletedFixture,
  'user.deleted': userDeletedFixture,
} as const satisfies Record<EventType, FiapxEvent>;
