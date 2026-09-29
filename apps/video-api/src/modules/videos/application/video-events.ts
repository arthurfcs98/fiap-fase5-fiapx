import type { FiapxEvent } from '@fiapx/contracts';
import { createEvent } from '@fiapx/contracts';
import type { User } from '../../auth/domain/user';
import type { Video } from '../domain/video';
import { ERROR_MESSAGE_MAX_LENGTH } from '../domain/video';

/**
 * `video.completed` / `video.failed` for the notification-service (contratos.md, section 2). They
 * are the only events carrying the user's e-mail and name (needed to send the e-mail); the
 * `userId` lets the notification-service anonymize them on `user.deleted` (section 12).
 * `null` for non-terminal states.
 */
export function terminalEventFor(
  video: Video,
  owner: User,
  correlationId: string,
): FiapxEvent | null {
  const common = {
    videoId: video.id,
    userId: owner.id,
    userEmail: owner.email,
    userName: owner.name,
    originalName: video.originalName,
  };
  if (video.status === 'COMPLETED') {
    return createEvent(
      'video.completed',
      { ...common, frameCount: video.frameCount ?? 1 },
      correlationId,
    );
  }
  if (video.status === 'FAILED') {
    return createEvent(
      'video.failed',
      {
        ...common,
        errorCode: video.errorCode ?? 'P0099',
        errorMessage: (video.errorMessage ?? '').slice(0, ERROR_MESSAGE_MAX_LENGTH),
      },
      correlationId,
    );
  }
  return null;
}
