/** ffprobe result reduced to what the acceptance policy needs. */
export interface VideoProbe {
  /** ffprobe `format_name` (e.g. `mov,mp4,m4a,3gp,3g2,mj2`). */
  formatName: string;
  /** Duration in seconds; `undefined` when the container does not report it. */
  durationSeconds?: number;
  /** Number of video streams (0 = audio/subtitle/data only). */
  videoStreamCount: number;
}

/**
 * Demuxers of the containers accepted on upload (`.mp4 .mov .mkv .webm .avi .wmv .flv`, the
 * base project list). Any other format detected by ffprobe (HLS playlist, image, subtitle...)
 * is refused before ffmpeg runs, even if it slipped through the API magic-bytes check.
 */
export const SUPPORTED_DEMUXERS: ReadonlySet<string> = new Set([
  'mov',
  'mp4',
  'matroska',
  'webm',
  'avi',
  'asf',
  'flv',
]);

export type ProbeVerdict =
  | { accepted: true }
  | { accepted: false; reason: 'invalid'; detail: string }
  | {
      accepted: false;
      reason: 'too_long';
      durationSeconds: number;
      maxDurationSeconds: number;
    };

/** Business rule: may this video go on to frame extraction? */
export function evaluateProbe(probe: VideoProbe, maxDurationSeconds: number): ProbeVerdict {
  const demuxers = probe.formatName
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (!demuxers.some((name) => SUPPORTED_DEMUXERS.has(name))) {
    return {
      accepted: false,
      reason: 'invalid',
      detail: `unsupported container format: ${probe.formatName || 'unknown'}`,
    };
  }
  if (probe.videoStreamCount === 0) {
    return { accepted: false, reason: 'invalid', detail: 'no video stream' };
  }
  if (probe.durationSeconds !== undefined && probe.durationSeconds > maxDurationSeconds) {
    return {
      accepted: false,
      reason: 'too_long',
      durationSeconds: probe.durationSeconds,
      maxDurationSeconds,
    };
  }
  return { accepted: true };
}
