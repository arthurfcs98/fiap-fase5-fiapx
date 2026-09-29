import type { TransactionScope } from '../../../shared/application/unit-of-work';
import type { StatusTransition, Video } from '../domain/video';
import { terminalEventFor } from './video-events';

/**
 * Persists a state change inside the caller's transaction (contratos.md, section 3): the video
 * row, one `video_status_history` row and, for COMPLETED/FAILED, the outbox event.
 */
export async function recordTransition(
  tx: TransactionScope,
  video: Video,
  transition: StatusTransition,
  correlationId: string,
  at: Date,
): Promise<void> {
  await tx.videos.update(video);
  await tx.videos.appendHistory(video.id, transition, at);
  if (!video.isTerminal) return;
  const owner = await tx.users.findById(video.userId);
  const event = owner ? terminalEventFor(video, owner, correlationId) : null;
  if (event) await tx.outbox.add(event, video.id);
}
