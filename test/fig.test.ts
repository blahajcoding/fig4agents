import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { decodeKiwiPayload, inspectFig, kiwiStrings, openFig, searchKiwiText } from "../src/fig.ts";
import { decodeScenegraph, sceneSummary } from "../src/scene.ts";
import { fetchFigmaScenegraph, parseFigmaFileKey } from "../src/figma-api.ts";

const fixture = "Base Gallery.fig";

test.skipIf(!existsSync(fixture))("inspects Figma archive fixture", async () => {
  const canvas = (await openFig(fixture)).read("canvas.fig");
  const summary = inspectFig(fixture, await openFig(fixture));
  expect(summary.format).toBe("fig-zip");
  expect(summary.canvas.format).toBe("fig-kiwi");
  expect(summary.canvas.kiwi?.preludeBytes).toBeGreaterThan(0);
  expect(summary.canvas.kiwi?.payloadBytes).toBeGreaterThan(1_000_000);
  expect(summary.assets.count).toBeGreaterThan(0);
  expect(kiwiStrings(canvas)).toContain("MessageType");
  expect(decodeKiwiPayload(canvas)?.length).toBeGreaterThan(1_000_000);
  expect(searchKiwiText(canvas, "All / Red 700")).toContain("All / Red 700");
});

test.skipIf(!existsSync(fixture))("decodes local scenegraph", async () => {
  const canvas = (await openFig(fixture)).read("canvas.fig");
  const scene = await decodeScenegraph(canvas, "/tmp/fig-local-test-cache");
  const summary = sceneSummary(scene) as { nodes: number; canvases: { name: string }[] };
  expect(summary.nodes).toBeGreaterThan(60_000);
  expect(summary.canvases.some((canvas) => canvas.name === "Internal Only Canvas")).toBe(true);
});

test("parses Figma links and normalizes REST nodes", async () => {
  expect(parseFigmaFileKey("https://www.figma.com/design/AbC_123/Name?node-id=1-2")).toBe("AbC_123");
  const request = async () => new Response(JSON.stringify({
    name: "Remote file",
    document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [
      { id: "1:2", name: "Page", type: "CANVAS", children: [{ id: "1:3", name: "Button", type: "FRAME" }] },
    ] },
  }));
  const result = await fetchFigmaScenegraph("AbC_123", "token", request as typeof fetch);
  expect(result.scene.nodes).toEqual([
    { id: "0:0", name: "Document", type: "DOCUMENT", visible: true, children: ["1:2"] },
    { id: "1:2", parentId: "0:0", name: "Page", type: "CANVAS", visible: true, children: ["1:3"] },
    { id: "1:3", parentId: "1:2", name: "Button", type: "FRAME", visible: true, children: [] },
  ]);
});
