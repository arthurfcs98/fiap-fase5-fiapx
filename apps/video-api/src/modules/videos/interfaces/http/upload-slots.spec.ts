import { UploadSlots } from './upload-slots';

describe('UploadSlots', () => {
  it('refuses beyond the limit and frees the slot on release (idempotent)', () => {
    const slots = new UploadSlots(2);

    const first = slots.tryAcquire('u1');
    const second = slots.tryAcquire('u2');
    expect(slots.inUse).toBe(2);
    expect(slots.tryAcquire('u3')).toBeNull();

    first?.();
    first?.();
    expect(slots.inUse).toBe(1);
    expect(slots.tryAcquire('u3')).not.toBeNull();
    second?.();
  });

  it('counts the uploads in flight of each user', () => {
    const slots = new UploadSlots(5);
    const a = slots.tryAcquire('u1');
    const b = slots.tryAcquire('u1');
    slots.tryAcquire('u2');

    expect(slots.inFlightFor('u1')).toBe(2);
    expect(slots.inFlightFor('u9')).toBe(0);

    a?.();
    expect(slots.inFlightFor('u1')).toBe(1);
    b?.();
    expect(slots.inFlightFor('u1')).toBe(0);
  });

  it('rejects an invalid limit', () => {
    expect(() => new UploadSlots(0)).toThrow(RangeError);
    expect(() => new UploadSlots(1.5)).toThrow(RangeError);
  });
});
