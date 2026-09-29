/**
 * Synthetic files with the right magic bytes (the API only inspects the header; the worker is
 * the one that decodes the video).
 */
export function mp4Bytes(bodyBytes = 1024): Buffer {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftypisom'),
    Buffer.from([0, 0, 2, 0]),
    Buffer.from('isomiso2'),
    Buffer.alloc(bodyBytes, 7),
  ]);
}

export function aviBytes(bodyBytes = 1024): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4),
    Buffer.from('AVI LIST'),
    Buffer.alloc(bodyBytes),
  ]);
}

export function pngBytes(): Buffer {
  return Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
}

export function textBytes(): Buffer {
  return Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\nsegment.ts\n');
}
