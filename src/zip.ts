import { inflateRawSync } from "node:zlib";

export type ZipEntry = {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

/** Minimal ZIP reader for Figma exports. ZIP64 and encrypted archives are unsupported. */
export class ZipArchive {
  private constructor(
    private readonly bytes: Buffer,
    readonly entries: ZipEntry[],
  ) {}

  static from(bytes: Buffer): ZipArchive {
    const end = findEndOfCentralDirectory(bytes);
    const entryCount = bytes.readUInt16LE(end + 10);
    const directorySize = bytes.readUInt32LE(end + 12);
    const directoryOffset = bytes.readUInt32LE(end + 16);

    if (directoryOffset + directorySize > bytes.length) {
      throw new Error("Invalid ZIP central directory bounds");
    }

    const entries: ZipEntry[] = [];
    let offset = directoryOffset;
    for (let index = 0; index < entryCount; index += 1) {
      if (bytes.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
        throw new Error(`Invalid ZIP central directory entry at ${offset}`);
      }
      const nameLength = bytes.readUInt16LE(offset + 28);
      const extraLength = bytes.readUInt16LE(offset + 30);
      const commentLength = bytes.readUInt16LE(offset + 32);
      entries.push({
        compression: bytes.readUInt16LE(offset + 10),
        compressedSize: bytes.readUInt32LE(offset + 20),
        uncompressedSize: bytes.readUInt32LE(offset + 24),
        localHeaderOffset: bytes.readUInt32LE(offset + 42),
        name: bytes.toString("utf8", offset + 46, offset + 46 + nameLength),
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return new ZipArchive(bytes, entries);
  }

  read(name: string): Buffer {
    const entry = this.entries.find((candidate) => candidate.name === name);
    if (!entry) throw new Error(`ZIP entry not found: ${name}`);
    const offset = entry.localHeaderOffset;
    if (this.bytes.readUInt32LE(offset) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error(`Invalid ZIP local header for ${name}`);
    }
    const nameLength = this.bytes.readUInt16LE(offset + 26);
    const extraLength = this.bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    const compressed = this.bytes.subarray(start, start + entry.compressedSize);
    if (entry.compression === 0) return Buffer.from(compressed);
    if (entry.compression === 8) return inflateRawSync(compressed);
    throw new Error(`Unsupported ZIP compression method ${entry.compression} for ${name}`);
  }
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  // EOCD comment is at most 65,535 bytes long.
  const start = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return offset;
  }
  throw new Error("Not a supported ZIP archive: end of central directory missing");
}
