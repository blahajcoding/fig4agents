#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assetOutputName, inspectFig, kiwiStrings, listEntries, openFig, searchKiwiText } from "./fig.ts";
import { decodeScenegraph, sceneSummary } from "./scene.ts";
import { fetchFigmaScenegraph } from "./figma-api.ts";
import { exportHtml } from "./html.ts";

const [command, file, output] = process.argv.slice(2);

if (!command || command === "--help" || command === "-h") usage();
if (!file) fail(command === "fetch" ? "Missing Figma URL or file key" : "Missing .fig file path");

try {
  if (command === "fetch") {
    const result = await fetchFigmaScenegraph(file, process.env.FIGMA_TOKEN ?? "");
    if (output) {
      await writeFile(output, JSON.stringify(result.scene, null, 2));
      console.log(JSON.stringify({ fileKey: result.fileKey, name: result.name, output, ...sceneSummary(result.scene) }, null, 2));
    } else {
      console.log(JSON.stringify({ fileKey: result.fileKey, name: result.name, ...sceneSummary(result.scene) }, null, 2));
    }
    process.exit(0);
  }
  const archive = await openFig(file);
  switch (command) {
    case "inspect":
      console.log(JSON.stringify(inspectFig(file, archive), null, 2));
      break;
    case "tree":
      console.log(JSON.stringify(listEntries(archive), null, 2));
      break;
    case "strings":
      console.log(JSON.stringify(kiwiStrings(archive.read("canvas.fig")), null, 2));
      break;
    case "search":
      if (!output) fail("Missing search query");
      console.log(JSON.stringify(searchKiwiText(archive.read("canvas.fig"), output), null, 2));
      break;
    case "scene": {
      const scene = await decodeScenegraph(archive.read("canvas.fig"), join(process.cwd(), ".fig-local-cache"));
      console.log(JSON.stringify(sceneSummary(scene), null, 2));
      break;
    }
    case "export-scene": {
      if (!output) fail("Missing output JSON path");
      const scene = await decodeScenegraph(archive.read("canvas.fig"), join(process.cwd(), ".fig-local-cache"));
      await writeFile(output, JSON.stringify(scene, null, 2));
      console.log(JSON.stringify({ output, nodes: scene.nodes.length }, null, 2));
      break;
    }
    case "export-assets": {
      if (!output) fail("Missing output directory");
      await mkdir(output, { recursive: true });
      const assets = listEntries(archive).filter((entry) => entry.name.startsWith("images/"));
      await Promise.all(assets.map((entry) => writeFile(join(output, assetOutputName(entry)), archive.read(entry.name))));
      console.log(JSON.stringify({ output, assets: assets.length }, null, 2));
      break;
    }
    case "export-html": {
      if (!output) fail("Missing output HTML path");
      const scene = await decodeScenegraph(archive.read("canvas.fig"), join(process.cwd(), ".fig-local-cache"));
      const result = await exportHtml(scene, archive, output, process.argv[5]);
      console.log(JSON.stringify({ output, frame: { id: result.frame.id, name: result.frame.name, width: result.frame.width, height: result.frame.height }, assets: result.assets }, null, 2));
      break;
    }
    default:
      fail(`Unknown command: ${command}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function usage(): never {
  console.log("Usage: fig <inspect|tree|strings|search|scene|export-scene|export-assets> <file.fig> [query|output]");
  console.log("       fig export-html <file.fig> <output.html> [frame-name]");
  console.log("       fig fetch <figma-url|file-key> [scenegraph.json]  (requires FIGMA_TOKEN)");
  process.exit(0);
}

function fail(message: string): never {
  console.error(`fig: ${message}`);
  process.exit(1);
}
