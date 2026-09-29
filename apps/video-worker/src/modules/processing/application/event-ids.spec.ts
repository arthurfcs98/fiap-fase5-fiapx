import { z } from 'zod';
import { workerEventId } from './event-ids';

const MESSAGE_ID = '0f8e7d6c-5b4a-4938-8271-605f4e3d2c1b';

describe('workerEventId', () => {
  it('is a UUID v5 accepted by the envelope schema', () => {
    const id = workerEventId(MESSAGE_ID, 'video.processing.completed');
    expect(z.uuid().safeParse(id).success).toBe(true);
    expect(id[14]).toBe('5');
  });

  it('is stable for the same message, type and attempt (redelivery → same id)', () => {
    expect(workerEventId(MESSAGE_ID, 'video.processing.started', 1)).toBe(
      workerEventId(MESSAGE_ID, 'video.processing.started', 1),
    );
  });

  it('differs by message, type and attempt', () => {
    const ids = new Set([
      workerEventId(MESSAGE_ID, 'video.processing.started', 1),
      workerEventId(MESSAGE_ID, 'video.processing.started', 2),
      workerEventId(MESSAGE_ID, 'video.processing.failed', 1),
      workerEventId(MESSAGE_ID, 'video.processing.completed'),
      workerEventId('1e2d3c4b-5a69-4788-9766-554433221100', 'video.processing.completed'),
    ]);
    expect(ids.size).toBe(5);
  });
});
