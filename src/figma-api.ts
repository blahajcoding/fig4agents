import type { SceneNode, Scenegraph } from "./scene.ts";

const FIGMA_API = "https://api.figma.com/v1/files";

export async function fetchFigmaScenegraph(
  urlOrFileKey: string,
  token: string,
  request: typeof fetch = fetch,
): Promise<{ fileKey: string; name: string; scene: Scenegraph }> {
  if (!token) throw new Error("Missing FIGMA_TOKEN environment variable");
  const fileKey = parseFigmaFileKey(urlOrFileKey);
  const response = await request(`${FIGMA_API}/${encodeURIComponent(fileKey)}`, {
    headers: { "X-Figma-Token": token },
  });
  if (!response.ok) {
    throw new Error(`Figma API request failed (${response.status}): ${await response.text()}`.slice(0, 500));
  }
  const file = await response.json() as FigmaFile;
  if (!file.document) throw new Error("Figma API response does not contain a document");
  return { fileKey, name: file.name ?? file.document.name ?? "Untitled Figma file", scene: normalizeDocument(file.document) };
}

export function parseFigmaFileKey(urlOrFileKey: string): string {
  const value = urlOrFileKey.trim();
  if (!value.includes("://")) return validKey(value);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Figma URL or file key");
  }
  if (!/(^|\.)figma\.com$/i.test(url.hostname)) throw new Error("URL must use figma.com");
  const match = url.pathname.match(/^\/(?:file|design)\/([^/]+)/i);
  if (!match) throw new Error("Figma URL must contain /file/FILE_KEY or /design/FILE_KEY");
  return validKey(match[1]);
}

export function normalizeDocument(document: FigmaNode): Scenegraph {
  const nodes: SceneNode[] = [];
  const visit = (node: FigmaNode, parentId?: string): void => {
    const id = node.id;
    const children = (node.children ?? []).map((child) => child.id);
    nodes.push({ id, parentId, name: node.name ?? "", type: node.type ?? "UNKNOWN", visible: node.visible !== false, children });
    for (const child of node.children ?? []) visit(child, id);
  };
  visit(document);
  return { format: "fig-local-scenegraph/v1", nodes };
}

function validKey(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid Figma file key");
  return value;
}

type FigmaFile = { name?: string; document?: FigmaNode };
export type FigmaNode = {
  id: string;
  name?: string;
  type?: string;
  visible?: boolean;
  children?: FigmaNode[];
};
