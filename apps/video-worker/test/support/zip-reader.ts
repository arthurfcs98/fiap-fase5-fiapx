/**
 * Minimal zip reader for tests (no dependency): lists the central directory and extracts STORE
 * entries, which is all the worker produces. Not for production use.
 */
export interface ZipEntry {
  name: string;
  /** 0 = STORE, 8 = DEFLATE. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

export function readZipEntries(zip: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(zip);
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(offset) !== CENTRAL_DIRECTORY_HEADER) {
      throw new Error(`invalid central directory header at offset ${offset}`);
    }
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    entries.push({
      method: zip.readUInt16LE(offset + 10),
      compressedSize: zip.readUInt32LE(offset + 20),
      uncompressedSize: zip.readUInt32LE(offset + 24),
      localHeaderOffset: zip.readUInt32LE(offset + 42),
      name: zip.toString('utf8', offset + 46, offset + 46 + nameLength),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Content of a STORE entry. */
export function readStoredEntry(zip: Buffer, entry: ZipEntry): Buffer {
  if (entry.method !== 0)
    throw new Error(`entry ${entry.name} is not stored (method ${entry.method})`);
  const offset = entry.localHeaderOffset;
  if (zip.readUInt32LE(offset) !== LOCAL_FILE_HEADER) {
    throw new Error(`invalid local file header for ${entry.name}`);
  }
  const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
  return zip.subarray(start, start + entry.compressedSize);
}

function findEndOfCentralDirectory(zip: Buffer): number {
  for (let offset = zip.length - 22; offset >= 0; offset -= 1) {
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error('not a zip file: end of central directory not found');
}
