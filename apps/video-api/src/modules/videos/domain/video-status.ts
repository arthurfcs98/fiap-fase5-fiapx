/** `video_status` enum (contratos.md, sections 3 and 5). */
export const VIDEO_STATUSES = ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'] as const;

export type VideoStatus = (typeof VIDEO_STATUSES)[number];

/** COMPLETED and FAILED are terminal: late events are ignored (idempotency). */
export function isTerminalStatus(status: VideoStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED';
}
