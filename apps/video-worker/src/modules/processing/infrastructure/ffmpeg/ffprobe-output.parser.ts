import { z } from 'zod';
import { MediaToolError } from '../../domain/media-tool.error';
import type { VideoProbe } from '../../domain/video-probe';

/** The part of `ffprobe -print_format json -show_format -show_streams` the worker reads. */
const ffprobeOutputSchema = z.object({
  format: z
    .object({
      format_name: z.string().optional(),
      duration: z.string().optional(),
    })
    .optional(),
  streams: z
    .array(
      z.object({
        codec_type: z.string().optional(),
        duration: z.string().optional(),
        disposition: z.object({ attached_pic: z.number().optional() }).optional(),
      }),
    )
    .optional(),
});

type FfprobeStream = NonNullable<z.output<typeof ffprobeOutputSchema>['streams']>[number];

/**
 * Turns the ffprobe JSON into a {@link VideoProbe}. Cover art (`attached_pic`) is not counted as
 * a video stream. The duration comes from the container and falls back to the longest video
 * stream; `undefined` when neither reports one.
 *
 * @throws MediaToolError (`failed`) when the output is not the expected JSON.
 */
export function parseFfprobeOutput(stdout: string): VideoProbe {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new MediaToolError('ffprobe', 'failed', 'output is not valid JSON');
  }
  const parsed = ffprobeOutputSchema.safeParse(json);
  if (!parsed.success) {
    throw new MediaToolError('ffprobe', 'failed', 'unexpected output structure');
  }

  const videoStreams = (parsed.data.streams ?? []).filter(isVideoStream);
  const streamDurations = videoStreams
    .map((stream) => toSeconds(stream.duration))
    .filter((seconds): seconds is number => seconds !== undefined);
  const durationSeconds =
    toSeconds(parsed.data.format?.duration) ??
    (streamDurations.length > 0 ? Math.max(...streamDurations) : undefined);

  return {
    formatName: parsed.data.format?.format_name ?? '',
    durationSeconds,
    videoStreamCount: videoStreams.length,
  };
}

function isVideoStream(stream: FfprobeStream): boolean {
  return stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1;
}

/** ffprobe prints durations as decimal strings (`"3.000000"`); anything else is unknown. */
function toSeconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
