import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { decodeKiwiPayload, decodeKiwiPrelude } from "./fig.ts";

const require = createRequire(import.meta.url);

export type SceneNode = {
  id: string;
  parentId?: string;
  name: string;
  type: string;
  visible: boolean;
  children: string[];
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
  return normalize(message.nodeChanges ?? []);
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

function normalize(rawNodes: RawNode[]): Scenegraph {
  const nodes = rawNodes.map((raw) => ({
    id: guid(raw.guid),
    parentId: raw.parentIndex?.guid ? guid(raw.parentIndex.guid) : undefined,
    name: raw.name ?? "",
    type: raw.type ?? "UNKNOWN",
    visible: raw.visible !== false,
    children: [],
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (node.parentId && node.parentId !== node.id) byId.get(node.parentId)?.children.push(node.id);
  }
  return { format: "fig-local-scenegraph/v1", nodes };
}

function guid(value: { sessionID?: number; localID?: number } | undefined): string {
  return `${value?.sessionID ?? 0}:${value?.localID ?? 0}`;
}

type RawNode = {
  guid?: { sessionID?: number; localID?: number };
  parentIndex?: { guid?: { sessionID?: number; localID?: number } };
  name?: string;
  type?: string;
  visible?: boolean;
};
