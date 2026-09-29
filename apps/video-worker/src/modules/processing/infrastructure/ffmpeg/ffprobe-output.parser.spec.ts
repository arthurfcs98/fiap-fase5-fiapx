import { MediaToolError } from '../../domain/media-tool.error';
import { parseFfprobeOutput } from './ffprobe-output.parser';

describe('parseFfprobeOutput', () => {
  it('reads the container, the duration and the video streams', () => {
    const output = JSON.stringify({
      streams: [
        { index: 0, codec_type: 'video', duration: '3.000000', width: 320 },
        { index: 1, codec_type: 'audio', duration: '3.1' },
      ],
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3.000000', size: '14424' },
    });

    expect(parseFfprobeOutput(output)).toEqual({
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSeconds: 3,
      videoStreamCount: 1,
    });
  });

  it('does not count cover art as video', () => {
    const output = JSON.stringify({
      streams: [{ codec_type: 'audio' }, { codec_type: 'video', disposition: { attached_pic: 1 } }],
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '120' },
    });

    expect(parseFfprobeOutput(output).videoStreamCount).toBe(0);
  });

  it('falls back to the longest video stream when the container has no duration', () => {
    const output = JSON.stringify({
      streams: [
        { codec_type: 'video', duration: '4.5' },
        { codec_type: 'video', duration: '9' },
        { codec_type: 'video' },
      ],
      format: { format_name: 'matroska,webm', duration: 'N/A' },
    });

    expect(parseFfprobeOutput(output)).toEqual({
      formatName: 'matroska,webm',
      durationSeconds: 9,
      videoStreamCount: 3,
    });
  });

  it('leaves the duration and format unknown when ffprobe reports nothing', () => {
    expect(parseFfprobeOutput('{}')).toEqual({
      formatName: '',
      durationSeconds: undefined,
      videoStreamCount: 0,
    });
    expect(
      parseFfprobeOutput(JSON.stringify({ streams: [{ codec_type: 'video', duration: '-1' }] }))
        .durationSeconds,
    ).toBeUndefined();
  });

  it.each([
    ['not JSON', 'Invalid data found', 'output is not valid JSON'],
    ['unexpected structure', '{"streams": "nope"}', 'unexpected output structure'],
  ])('%s → MediaToolError(failed)', (_case, stdout, detail) => {
    let error: unknown;
    try {
      parseFfprobeOutput(stdout);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MediaToolError);
    expect(error).toMatchObject({ tool: 'ffprobe', failure: 'failed', detail });
  });
});
