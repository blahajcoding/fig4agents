import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { decodeKiwiPayload, decodeKiwiPrelude } from "./fig.ts";

const require = createRequire(import.meta.url);

export type Paint = {
  type: string;
  color?: { r: number; g: number; b: number; a: number };
  opacity?: number;
  blendMode?: string;
  imageRef?: string;
  imageName?: string;
};

export type Effect = {
  type: string;
  color?: { r: number; g: number; b: number; a: number };
  offsetX?: number;
  offsetY?: number;
  radius?: number;
  spread?: number;
};

export type TextRun = {
  text: string;
  fontFamily?: string;
  fontWeight?: string;
  color?: { r: number; g: number; b: number; a: number };
};

export type SceneNode = {
  id: string;
  parentId?: string;
  name: string;
  type: string;
  visible: boolean;
  children: string[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  opacity?: number;
  cornerRadius?: number;
  cornerRadii?: { tl?: number; tr?: number; br?: number; bl?: number };
  fills?: Paint[];
  strokes?: Paint[];
  strokeWeight?: number;
  strokeAlign?: string;
  effects?: Effect[];
  clipsContent?: boolean;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string;
  color?: { r: number; g: number; b: number; a: number };
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  lineHeight?: number;
  lineHeightUnits?: string;
  letterSpacing?: number;
  letterSpacingUnits?: string;
  textCase?: string;
  textRuns?: TextRun[];
  vectorPaths?: string[];
  fillRule?: "evenodd" | "nonzero";
};

export type Scenegraph = {
  format: "fig-local-scenegraph/v1";
  nodes: SceneNode[];
};

export async function decodeScenegraph(canvas: Buffer, cacheDirectory: string): Promise<Scenegraph> {
  const schema = decodeKiwiPrelude(canvas);
  const payload = decodeKiwiPayload(canvas);
  if (!schema || !payload) throw new Error("canvas.fig is not a supported complete fig-kiwi document");

  const decoderPath = await ensureDecoder(schema, cacheDirectory);
  const decoder = require(decoderPath) as { decodeMessage(data: Uint8Array): { nodeChanges?: RawNode[] } };
  const message = decoder.decodeMessage(payload);
  return normalize(message.nodeChanges ?? [], message.blobs ?? []);
}

export function sceneSummary(scene: Scenegraph): object {
  const byType: Record<string, number> = {};
  const canvases: Pick<SceneNode, "id" | "name">[] = [];
  for (const node of scene.nodes) {
    byType[node.type] = (byType[node.type] ?? 0) + 1;
    if (node.type === "CANVAS") canvases.push({ id: node.id, name: node.name });
  }
  return { format: scene.format, nodes: scene.nodes.length, byType, canvases };
}

async function ensureDecoder(schema: Buffer, cacheDirectory: string): Promise<string> {
  const digest = createHash("sha256").update(schema).digest("hex");
  const directory = join(cacheDirectory, "decoders");
  const schemaPath = join(directory, `${digest}.bkiwi`);
  const decoderPath = join(directory, `${digest}.cjs`);
  try {
    require.resolve(decoderPath);
    return decoderPath;
  } catch {
    await mkdir(directory, { recursive: true });
    await writeFile(schemaPath, schema);
    const packageDirectory = dirname(require.resolve("kiwi-schema/package.json"));
    const compilerPath = join(packageDirectory, "cli.js");
    const generated = spawnSync(process.execPath, [compilerPath, "--schema", schemaPath, "--js", decoderPath], {
      encoding: "utf8",
    });
    if (generated.status !== 0) {
      throw new Error(`Kiwi decoder generation failed: ${generated.stderr || generated.stdout}`.trim());
    }
    // Bun does not search the project dependency path from arbitrary cache directories.
    // Make generated CommonJS decoder independent from its cache location.
    const runtimePath = join(packageDirectory, "kiwi.js");
    const source = await readFile(decoderPath, "utf8");
    await writeFile(decoderPath, source.replace('require("kiwi-schema")', `require(${JSON.stringify(runtimePath)})`));
    return decoderPath;
  }
}

function normalize(rawNodes: RawNode[], blobs: { bytes?: Uint8Array }[]): Scenegraph {
  const nodes = rawNodes.map((raw) => {
    const t = raw.transform;
    const textPaint =
      raw.textData?.styleOverrideTable?.flatMap((s: { fillPaints?: Paint[] }) => s.fillPaints ?? []).find(Boolean) ??
      raw.fillPaints?.find((p: Paint) => p.type === "SOLID");
    const fills: Paint[] = raw.fillPaints
      ?.filter((p: Paint) => p && p.type)
      .map((p: Paint & { image?: { hash?: number[]; name?: string }; blendMode?: string }) => {
        if (p.type === "IMAGE" && p.image?.hash) {
          // `hash` is decoded as a Uint8Array. TypedArray#map coerces callback
          // results back to bytes, so convert it to a normal array before hex encoding.
          const hex = Array.from(p.image.hash as ArrayLike<number>, (b) => b.toString(16).padStart(2, "0")).join("");
          return { type: p.type, imageRef: hex, imageName: p.image.name, opacity: p.opacity } as Paint;
        }
        return { type: p.type, color: p.color, opacity: p.opacity, blendMode: p.blendMode } as Paint;
      });
    const strokes: Paint[] = raw.strokePaints
      ?.filter((p: Paint) => p && p.type)
      .map((p: Paint) => ({ type: p.type, color: p.color, opacity: p.opacity, blendMode: p.blendMode }));
    const effects: Effect[] = raw.effects
      ?.filter((e: { type?: string; visible?: boolean }) => e && e.visible !== false)
      .map((e: any) => ({
        type: e.type,
        color: e.color,
        offsetX: e.offset?.x,
        offsetY: e.offset?.y,
        radius: e.radius,
        spread: e.spread,
      }));
    const perCorner =
      raw.rectangleCornerRadiiIndependent || raw.rectangleTopLeftCornerRadius != null
        ? {
            tl: raw.rectangleTopLeftCornerRadius,
            tr: raw.rectangleTopRightCornerRadius,
            br: raw.rectangleBottomRightCornerRadius,
            bl: raw.rectangleBottomLeftCornerRadius,
          }
        : undefined;
    const textRuns = normalizedTextRuns(raw.textData);
    const vectorPaths = raw.fillGeometry
      ?.map((geometry) => geometry.commandsBlob == null ? undefined : pathFromCommands(blobs[geometry.commandsBlob]?.bytes))
      .filter((path): path is string => Boolean(path));
    return {
      id: guid(raw.guid),
      parentId: raw.parentIndex?.guid ? guid(raw.parentIndex.guid) : undefined,
      name: raw.name ?? "",
      type: raw.type ?? "UNKNOWN",
      visible: raw.visible !== false,
      children: [] as string[],
      x: t ? t.m02 : undefined,
      y: t ? t.m12 : undefined,
      width: raw.size ? raw.size.x : undefined,
      height: raw.size ? raw.size.y : undefined,
      rotation: t && (t.m01 !== 0 || t.m10 !== 0) ? Math.atan2(t.m10, t.m00) : undefined,
      opacity: raw.opacity,
      cornerRadius: raw.cornerRadius,
      cornerRadii: perCorner,
      backgroundColor: raw.backgroundColor,
      fills,
      strokes,
      strokeWeight: raw.strokeWeight,
      strokeAlign: raw.strokeAlign,
      effects,
      clipsContent: raw.clipsContent,
      text: raw.textData?.characters,
      textRuns,
      fontSize: raw.fontSize,
      fontFamily: raw.fontName?.family,
      fontWeight: raw.fontName?.style,
      color: textPaint?.color,
      textAlignHorizontal: raw.textAlignHorizontal,
      textAlignVertical: raw.textAlignVertical,
      lineHeight: raw.lineHeight?.value,
      lineHeightUnits: raw.lineHeight?.units,
      letterSpacing: raw.letterSpacing?.value,
      letterSpacingUnits: raw.letterSpacing?.units,
      textCase: raw.textCase,
      vectorPaths,
      fillRule: raw.fillGeometry?.some((geometry) => geometry.windingRule === "ODD") ? "evenodd" : "nonzero",
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (node.parentId && node.parentId !== node.id) byId.get(node.parentId)?.children.push(node.id);
  }
  return { format: "fig-local-scenegraph/v1", nodes };
}

function normalizedTextRuns(textData: RawNode["textData"]): TextRun[] | undefined {
  const text = textData?.characters;
  const ids = textData?.characterStyleIDs;
  if (!text || !ids?.length || !textData?.styleOverrideTable?.length) return undefined;
  const overrides = new Map(textData.styleOverrideTable.map((style) => [style.styleID, style]));
  const runs: TextRun[] = [];
  let start = 0;
  while (start < text.length) {
    const styleId = ids[start] ?? 0;
    let end = start + 1;
    while (end < text.length && (ids[end] ?? 0) === styleId) end++;
    const style = overrides.get(styleId);
    const paint = style?.fillPaints?.find((fill) => fill.type === "SOLID" && fill.color);
    runs.push({ text: text.slice(start, end), fontFamily: style?.fontName?.family, fontWeight: style?.fontName?.style, color: paint?.color });
    start = end;
  }
  return runs;
}

function pathFromCommands(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes?.length) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const next = () => { const value = view.getFloat32(offset, true); offset += 4; return number(value); };
  let path = "";
  while (offset < bytes.length) {
    const command = bytes[offset++];
    if (command === 0) { path += "Z"; continue; }
    if (command === 1 || command === 2) {
      if (offset + 8 > bytes.length) return undefined;
      path += `${command === 1 ? "M" : "L"}${next()} ${next()}`;
      continue;
    }
    if (command === 4) {
      if (offset + 24 > bytes.length) return undefined;
      path += `C${next()} ${next()} ${next()} ${next()} ${next()} ${next()}`;
      continue;
    }
    return undefined;
  }
  return path || undefined;
}

function number(value: number): string { return Number(value.toFixed(4)).toString(); }

function guid(value: { sessionID?: number; localID?: number } | undefined): string {
  return `${value?.sessionID ?? 0}:${value?.localID ?? 0}`;
}

type RawNode = {
  guid?: { sessionID?: number; localID?: number };
  parentIndex?: { guid?: { sessionID?: number; localID?: number } };
  name?: string;
  type?: string;
  visible?: boolean;
  opacity?: number;
  cornerRadius?: number;
  rectangleTopLeftCornerRadius?: number;
  rectangleTopRightCornerRadius?: number;
  rectangleBottomRightCornerRadius?: number;
  rectangleBottomLeftCornerRadius?: number;
  rectangleCornerRadiiIndependent?: boolean;
  size?: { x: number; y: number };
  backgroundColor?: { r: number; g: number; b: number; a: number };
  transform?: { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number };
  fillPaints?: (Paint & { image?: { hash?: number[]; name?: string }; blendMode?: string })[];
  strokePaints?: (Paint & { blendMode?: string })[];
  strokeWeight?: number;
  strokeAlign?: string;
  effects?: { type?: string; visible?: boolean; color?: { r: number; g: number; b: number; a: number }; offset?: { x: number; y: number }; radius?: number; spread?: number }[];
  clipsContent?: boolean;
  fontSize?: number;
  fontName?: { family?: string; style?: string; postscript?: string };
  textData?: {
    characters?: string;
    characterStyleIDs?: number[];
    styleOverrideTable?: { styleID?: number; fontName?: { family?: string; style?: string }; fillPaints?: Paint[] }[];
  };
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  lineHeight?: { value?: number; units?: string };
  letterSpacing?: { value?: number; units?: string };
  textCase?: string;
  fillGeometry?: { commandsBlob?: number; windingRule?: string }[];
};
