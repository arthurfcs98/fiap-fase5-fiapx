const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;

/**
 * Entry names of a zip file, read from its central directory (no extra dependency). Enough for
 * the worker's zips: no zip64, no archive comment longer than 64 KiB.
 */
export function zipEntries(zip: Buffer): string[] {
  let eocd = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65_557); offset -= 1) {
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('não é um arquivo zip (fim do diretório central ausente)');

  const total = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let index = 0; index < total; index += 1) {
    if (zip.readUInt32LE(offset) !== CENTRAL_DIRECTORY_HEADER) {
      throw new Error(`entrada ${index} do diretório central inválida`);
    }
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}
