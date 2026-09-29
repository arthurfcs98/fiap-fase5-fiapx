import { aVideo, NOW } from '../../../../test/support/fakes';
import { ERROR_MESSAGE_MAX_LENGTH, Video } from './video';
import { isTerminalStatus } from './video-status';

const LATER = new Date(NOW.getTime() + 60_000);
const result = { zipKey: 'u/v.zip', frameCount: 3, zipSizeBytes: 2048 };
const failure = { errorCode: 'P0001', errorMessage: 'O arquivo não é um vídeo válido.' };

describe('Video (state machine, contratos.md section 3)', () => {
  it('queue creates a QUEUED video and its first history row', () => {
    const { video, transition } = Video.queue(
      {
        id: 'id',
        userId: 'user',
        originalName: 'a.mp4',
        sizeBytes: 10,
        contentType: 'video/mp4',
        rawKey: 'user/id.mp4',
        idempotencyKey: 'k',
      },
      NOW,
    );
    expect(video.toSnapshot()).toMatchObject({
      status: 'QUEUED',
      attempts: 0,
      zipKey: null,
      createdAt: NOW,
      updatedAt: NOW,
      expiredAt: null,
    });
    expect(transition).toEqual({ from: null, to: 'QUEUED', reason: 'Upload recebido' });
    expect(video.isTerminal).toBe(false);
    expect(video.isDownloadable).toBe(false);
  });

  it('started: QUEUED → PROCESSING with the attempt and startedAt', () => {
    const video = aVideo();
    expect(video.start(1, LATER)).toEqual({
      from: 'QUEUED',
      to: 'PROCESSING',
      reason: 'Processamento iniciado (tentativa 1)',
    });
    expect(video.toSnapshot()).toMatchObject({
      status: 'PROCESSING',
      attempts: 1,
      startedAt: LATER,
    });
  });

  it('started again with a newer attempt: PROCESSING → PROCESSING (retry); older/equal is ignored', () => {
    const video = aVideo({ status: 'PROCESSING', attempts: 1, startedAt: NOW });
    expect(video.start(1, LATER)).toBeNull();
    expect(video.start(2, LATER)).toEqual({
      from: 'PROCESSING',
      to: 'PROCESSING',
      reason: 'Nova tentativa de processamento (tentativa 2)',
    });
    expect(video.toSnapshot()).toMatchObject({ attempts: 2, startedAt: NOW });
  });

  it.each(['COMPLETED', 'FAILED'] as const)('started after %s is ignored (terminal)', (status) => {
    const video = aVideo({ status });
    expect(video.start(3, LATER)).toBeNull();
    expect(video.status).toBe(status);
  });

  it.each(['QUEUED', 'PROCESSING'] as const)(
    'completed from %s → COMPLETED with zip data',
    (status) => {
      const video = aVideo({ status });
      expect(video.complete(result, LATER)).toEqual({
        from: status,
        to: 'COMPLETED',
        reason: 'Processamento concluído (3 frames)',
      });
      expect(video.toSnapshot()).toMatchObject({
        status: 'COMPLETED',
        zipKey: 'u/v.zip',
        frameCount: 3,
        zipSizeBytes: 2048,
        completedAt: LATER,
        attempts: 1,
      });
      expect(video.isTerminal).toBe(true);
      expect(video.isDownloadable).toBe(true);
    },
  );

  it.each(['QUEUED', 'PROCESSING'] as const)('failed from %s → FAILED with the error', (status) => {
    const video = aVideo({ status, attempts: 1 });
    expect(video.fail(failure, LATER, 2)).toEqual({
      from: status,
      to: 'FAILED',
      reason: 'Falha no processamento (P0001)',
    });
    expect(video.toSnapshot()).toMatchObject({
      status: 'FAILED',
      errorCode: 'P0001',
      errorMessage: failure.errorMessage,
      attempts: 2,
      completedAt: LATER,
    });
  });

  it('failed with a custom reason (dead-letter) keeps the attempts and cuts long messages', () => {
    const video = aVideo({ status: 'PROCESSING', attempts: 4 });
    const transition = video.fail(
      { errorCode: 'P0099', errorMessage: 'x'.repeat(900) },
      LATER,
      undefined,
      `Dead-letter ${'y'.repeat(300)}`,
    );
    expect(transition?.reason).toHaveLength(200);
    expect(video.errorMessage).toHaveLength(ERROR_MESSAGE_MAX_LENGTH);
    expect(video.toSnapshot().attempts).toBe(4);
  });

  it.each([
    ['COMPLETED', 'complete'],
    ['COMPLETED', 'fail'],
    ['FAILED', 'complete'],
    ['FAILED', 'fail'],
  ] as const)('%s absorbs a late %s (no change)', (status, action) => {
    const video = aVideo({ status, zipKey: status === 'COMPLETED' ? 'z' : null });
    const before = video.toSnapshot();
    const transition =
      action === 'complete' ? video.complete(result, LATER) : video.fail(failure, LATER);
    expect(transition).toBeNull();
    expect(video.toSnapshot()).toEqual(before);
  });

  it('expireZip removes the zip key and blocks the download (410)', () => {
    const video = aVideo({ status: 'COMPLETED', zipKey: 'u/v.zip', completedAt: NOW });
    video.expireZip(LATER);
    expect(video.toSnapshot()).toMatchObject({ zipKey: null, expiredAt: LATER, updatedAt: LATER });
    expect(video.isDownloadable).toBe(false);
    expect(video.expiredAt).toEqual(LATER);
  });

  it('exposes read-only accessors and restores an independent copy', () => {
    const video = aVideo({
      status: 'FAILED',
      errorCode: 'P0002',
      errorMessage: 'm',
      frameCount: 1,
    });
    expect([video.id, video.userId, video.originalName, video.rawKey]).toEqual([
      video.toSnapshot().id,
      video.toSnapshot().userId,
      'demo.mp4',
      video.toSnapshot().rawKey,
    ]);
    expect([video.zipKey, video.frameCount, video.errorCode, video.errorMessage]).toEqual([
      null,
      1,
      'P0002',
      'm',
    ]);
    const snapshot = video.toSnapshot();
    snapshot.status = 'QUEUED';
    expect(video.status).toBe('FAILED');
  });

  it('terminal statuses are COMPLETED and FAILED', () => {
    expect(
      ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'].map((s) => isTerminalStatus(s as never)),
    ).toEqual([false, false, true, true]);
  });
});
