import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SceneNode, Scenegraph } from "./scene.ts";
import { listEntries, type ZipArchive } from "./fig.ts";

const textAlign: Record<string, string> = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" };

export async function exportHtml(scene: Scenegraph, archive: ZipArchive, output: string, frameName?: string): Promise<{ frame: SceneNode; assets: number }> {
  const frame = frameName ? scene.nodes.find((node) => node.name === frameName) : scene.nodes.find((node) => node.type === "CANVAS");
  if (!frame) throw new Error(frameName ? `No node named ${JSON.stringify(frameName)}` : "No canvas found");

  const byId = new Map(scene.nodes.map((node) => [node.id, node]));
  const usedImages = new Set<string>();
  const render = (node: SceneNode, root = false): string => {
    if (!node.visible) return "";
    const style = root
      ? ["position:relative", "left:0", "top:0"]
      : ["position:absolute", `left:${px(node.x)}px`, `top:${px(node.y)}px`];
    if (node.width != null) style.push(`width:${px(node.width)}px`);
    if (node.height != null) style.push(`height:${px(node.height)}px`);
    if (node.opacity != null && node.opacity !== 1) style.push(`opacity:${node.opacity}`);
    if (node.rotation) style.push(`transform:rotate(${node.rotation}rad)`, "transform-origin:top left");

    // Text paint is applied to glyphs below. Applying it as a box background is
    // a common but very visible Figma-to-HTML rendering error.
    const fill = node.type === "TEXT" || node.type === "VECTOR" ? undefined : node.fills?.find((paint) => paint.type === "SOLID" && paint.color);
    if (fill?.color) style.push(`background:${rgba(fill.color, fill.opacity ?? fill.color.a)}`);
    const image = node.fills?.find((paint) => paint.type === "IMAGE" && paint.imageRef);
    if (image?.imageRef) {
      usedImages.add(image.imageRef);
      style.push(`background-image:url(${JSON.stringify(`assets/${image.imageRef}`)})`, "background-size:cover", "background-position:center", "background-repeat:no-repeat");
    }
    const stroke = node.strokes?.find((paint) => paint.type === "SOLID" && paint.color);
    if (stroke?.color && node.strokeWeight) style.push(`border:${px(node.strokeWeight)}px solid ${rgba(stroke.color, stroke.opacity ?? stroke.color.a)}`);
    const radii = node.cornerRadii;
    if (radii?.tl != null) style.push(`border-radius:${px(radii.tl)}px ${px(radii.tr)}px ${px(radii.br)}px ${px(radii.bl)}px`);
    else if (node.cornerRadius != null) style.push(`border-radius:${px(node.cornerRadius)}px`);
    const shadows = node.effects?.flatMap((effect) => {
      if (effect.type !== "DROP_SHADOW" && effect.type !== "INNER_SHADOW") return [];
      return [`${effect.type === "INNER_SHADOW" ? "inset " : ""}${px(effect.offsetX)}px ${px(effect.offsetY)}px ${px(effect.radius)}px ${px(effect.spread)}px ${rgba(effect.color, effect.color?.a)}`];
    });
    if (shadows?.length) style.push(`box-shadow:${shadows.join(",")}`);
    if (node.clipsContent) style.push("overflow:hidden");

    let content = "";
    if (node.text != null) {
      const lineHeight = node.lineHeight ?? (node.fontSize ?? 14) * 1.25;
      const singleLine = node.height == null || node.height <= lineHeight + 0.5;
      style.push(`color:${rgba(node.color, 1)}`, `font-family:${cssString(node.fontFamily ?? "Inter")},sans-serif`, `font-size:${px(node.fontSize ?? 14)}px`, `font-weight:${weight(node.fontWeight)}`, `line-height:${px(lineHeight)}px`, singleLine ? "white-space:pre" : "white-space:pre-wrap");
      if (node.textAlignHorizontal) style.push(`text-align:${textAlign[node.textAlignHorizontal] ?? "left"}`);
      if (node.letterSpacing) style.push(`letter-spacing:${node.letterSpacing}px`);
      if (node.textCase === "UPPER") style.push("text-transform:uppercase");
      content += node.textRuns?.length ? node.textRuns.map((run) => {
        const runStyle = [
          run.fontFamily && `font-family:${cssString(run.fontFamily)},sans-serif`,
          run.fontWeight && `font-weight:${weight(run.fontWeight)}`,
          run.color && `color:${rgba(run.color, 1)}`,
        ].filter(Boolean).join(";");
        return runStyle ? `<span style="${escapeAttribute(runStyle)}">${escapeHtml(run.text)}</span>` : escapeHtml(run.text);
      }).join("") : escapeHtml(node.text);
    }
    for (const id of node.children) {
      const child = byId.get(id);
      if (child) content += render(child);
    }
    const attrs = `data-fig-node="${escapeAttribute(node.id)}" data-fig-name="${escapeAttribute(node.name)}" style="${escapeAttribute(style.join(";"))}"`;
    if (node.type === "VECTOR" && node.vectorPaths?.length) {
      const vectorFill = node.fills?.find((paint) => paint.type === "SOLID" && paint.color);
      const color = vectorFill?.color ? rgba(vectorFill.color, vectorFill.opacity ?? vectorFill.color.a) : "transparent";
      const viewBox = `0 0 ${px(node.width)} ${px(node.height)}`;
      return `<svg ${attrs} viewBox="${viewBox}" preserveAspectRatio="none" aria-hidden="true">${node.vectorPaths.map((path) => `<path d="${path}" fill="${color}" fill-rule="${node.fillRule ?? "nonzero"}"/>`).join("")}</svg>`;
    }
    return `<div ${attrs}>${content}</div>`;
  };

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(frame.name)}</title><style>*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#000}body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.fig-frame{width:${px(frame.width)}px;height:${px(frame.height)}px;overflow:hidden}</style></head><body><main class="fig-frame">${render(frame, true)}</main></body></html>`;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, html);

  const assetDirectory = join(dirname(output), "assets");
  await mkdir(assetDirectory, { recursive: true });
  let assets = 0;
  for (const entry of listEntries(archive).filter((entry) => entry.name.startsWith("images/"))) {
    const name = basename(entry.name);
    if (usedImages.has(name)) { await writeFile(join(assetDirectory, name), archive.read(entry.name)); assets++; }
  }
  return { frame, assets };
}

function px(value: number | undefined): number { return Math.round(value ?? 0); }
function rgba(color: { r: number; g: number; b: number; a?: number } | undefined, alpha?: number): string {
  if (!color) return "transparent";
  return `rgba(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)},${alpha ?? color.a ?? 1})`;
}
function weight(style: string | undefined): number { if (!style) return 400; if (/Extra Bold/.test(style)) return 800; if (/Semi Bold/.test(style)) return 600; if (/Bold/.test(style)) return 700; if (/Medium/.test(style)) return 500; if (/Light/.test(style)) return 300; return 400; }
function escapeHtml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function escapeAttribute(value: string): string { return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function cssString(value: string): string { return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`; }
