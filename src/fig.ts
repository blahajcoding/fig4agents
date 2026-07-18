import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ZipArchive, type ZipEntry } from "./zip.ts";
import { inflateRawSync } from "node:zlib";

// `fig-kiwie` is on-disk magic; Figma's binary encoding is commonly called Kiwi.
const KIWI_HEADER = Buffer.from("fig-kiwie\0", "ascii");

export type FigSummary = {
  path: string;
  format: "fig-zip";
  fileName?: string;
  exportedAt?: string;
  canvas: {
    entry: string;
    bytes: number;
    format: "fig-kiwi" | "unknown";
    kiwi?: {
      headerBytes: number;
      preludeCompressedBytes: number;
      preludeBytes: number;
      payloadCompressedBytes: number;
      payloadBytes: number;
    };
  };
  thumbnail?: { entry: string; bytes: number };
  assets: { count: number; bytes: number };
  archive: { entries: number; bytes: number };
  meta: unknown;
};

export async function openFig(path: string): Promise<ZipArchive> {
  return ZipArchive.from(await readFile(path));
}

export function inspectFig(path: string, archive: ZipArchive): FigSummary {
  const metaEntry = archive.entries.find((entry) => entry.name === "meta.json");
  const meta = metaEntry ? JSON.parse(archive.read(metaEntry.name).toString("utf8")) : null;
  const canvas = requiredEntry(archive.entries, "canvas.fig");
  const thumbnail = archive.entries.find((entry) => entry.name === "thumbnail.png");
  const assets = archive.entries.filter((entry) => entry.name.startsWith("images/") && !entry.name.endsWith("/"));
  const canvasBytes = archive.read(canvas.name);
  const kiwi = decodeKiwiPrelude(canvasBytes);
  const payload = decodeKiwiPayload(canvasBytes);

  return {
    path,
    format: "fig-zip",
    fileName: typeof meta?.file_name === "string" ? meta.file_name : undefined,
    exportedAt: typeof meta?.exported_at === "string" ? meta.exported_at : undefined,
    canvas: {
      entry: canvas.name,
      bytes: canvas.uncompressedSize,
      format: kiwi ? "fig-kiwi" : "unknown",
      kiwi: kiwi && {
        headerBytes: 16,
        preludeCompressedBytes: canvasBytes.readUInt32LE(12),
        preludeBytes: kiwi.length,
        payloadCompressedBytes: canvasBytes.readUInt32LE(16 + canvasBytes.readUInt32LE(12)),
        payloadBytes: payload?.length ?? 0,
      },
    },
    thumbnail: thumbnail ? { entry: thumbnail.name, bytes: thumbnail.uncompressedSize } : undefined,
    assets: { count: assets.length, bytes: assets.reduce((total, entry) => total + entry.uncompressedSize, 0) },
    archive: { entries: archive.entries.length, bytes: archive.entries.reduce((total, entry) => total + entry.uncompressedSize, 0) },
    meta,
  };
}

/**
 * Decodes first Kiwi block. It contains format tables/schema, not document nodes.
 * Further blocks need Kiwi's undocumented object codec.
 */
export function decodeKiwiPrelude(canvas: Buffer): Buffer | undefined {
  if (!canvas.subarray(0, KIWI_HEADER.length).equals(KIWI_HEADER) || canvas.length <= 16) return undefined;
  try {
    return inflateRawSync(canvas.subarray(16));
  } catch {
    return undefined;
  }
}

export function kiwiStrings(canvas: Buffer): string[] {
  const prelude = decodeKiwiPrelude(canvas);
  if (!prelude) throw new Error("canvas.fig is not a supported fig-kiwi stream");
  const unique = new Set<string>();
  // Kiwi interleaves values with length/type bytes; printable runs are stable schema tokens.
  for (const match of prelude.toString("latin1").matchAll(/[ -~]{3,}/g)) unique.add(match[0]);
  return [...unique].sort((left, right) => left.localeCompare(right));
}

export function decodeKiwiPayload(canvas: Buffer): Buffer | undefined {
  if (!canvas.subarray(0, KIWI_HEADER.length).equals(KIWI_HEADER) || canvas.length < 20) return undefined;
  const preludeLength = canvas.readUInt32LE(12);
  const payloadOffset = 16 + preludeLength;
  if (payloadOffset + 4 > canvas.length) return undefined;
  const payloadLength = canvas.readUInt32LE(payloadOffset);
  const payloadStart = payloadOffset + 4;
  if (payloadStart + payloadLength > canvas.length) return undefined;
  try {
    return Buffer.from(Bun.zstdDecompressSync(canvas.subarray(payloadStart, payloadStart + payloadLength)));
  } catch {
    return undefined;
  }
}

export function kiwiTextRuns(canvas: Buffer, minimumLength = 3): string[] {
  const payload = decodeKiwiPayload(canvas);
  if (!payload) throw new Error("canvas.fig does not contain a readable Kiwi Zstandard payload");
  const unique = new Set<string>();
  for (const match of payload.toString("latin1").matchAll(new RegExp(`[ -~]{${minimumLength},}`, "g"))) {
    unique.add(match[0]);
  }
  return [...unique];
}

export function searchKiwiText(canvas: Buffer, query: string, limit = 100): string[] {
  const needle = query.toLocaleLowerCase();
  return kiwiTextRuns(canvas)
    .filter((run) => run.toLocaleLowerCase().includes(needle))
    .slice(0, limit);
}

export function listEntries(archive: ZipArchive): ZipEntry[] {
  return archive.entries.filter((entry) => !entry.name.endsWith("/"));
}

export function assetOutputName(entry: ZipEntry): string {
  return basename(entry.name);
}

function requiredEntry(entries: ZipEntry[], name: string): ZipEntry {
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Invalid .fig: missing ${name}`);
  return entry;
}
