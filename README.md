# fig-local

Offline inspection and asset extraction for Figma `.fig` exports. No Figma API or MCP required.

Licensed under [GPL-2.0-only](./LICENSE).

## Commands

```bash
bun run fig -- inspect "Base Gallery.fig"
bun run fig -- tree "Base Gallery.fig"
bun run fig -- strings "Base Gallery.fig"
bun run fig -- search "Base Gallery.fig" "All / Red 700"
bun run fig -- scene "Base Gallery.fig"
bun run fig -- export-scene "Base Gallery.fig" ./scenegraph.json
bun run fig -- export-assets "Base Gallery.fig" ./assets
```

## Figma Links

Set a Figma personal access token in your shell, then fetch a file URL or file key:

```bash
export FIGMA_TOKEN="..."
bun run fig -- fetch "https://www.figma.com/design/FILE_KEY/File-name" ./scenegraph.json
```

`fetch` calls Figma's `GET /v1/files/:file_key` endpoint with `X-Figma-Token`. It normalizes REST document nodes into `fig-local-scenegraph/v1`; no token is written to output or cache.

`inspect` emits agent-friendly JSON: metadata, preview availability, archive size, embedded image count, and canvas encoding.

`AGENTS.md` makes this workflow available to OpenCode agents in this project. They call the local CLI through shell, so no MCP server is involved.

`scene` creates `.fig-local-cache/decoders/<schema-sha256>.cjs` on first use. The generated decoder is reused for every `.fig` file with same embedded schema. Delete cache any time; CLI rebuilds it locally.

## Format boundary

Modern `.fig` exports are ZIP bundles. This tool parses `meta.json`, `thumbnail.png`, and `images/*` locally. Their design graph is `canvas.fig`, detected as `fig-kiwi`, an undocumented Figma binary stream. Current decoder inflates Kiwi prelude, decompresses its Zstandard document payload, generates a decoder from each file's embedded schema, and exports normalized nodes with parent/child relationships.

Future Kiwi decoder belongs behind `src/fig.ts`; commands should consume normalized document JSON rather than raw Figma binary data. Asset and metadata workflows remain useful if decoding fails.

## Status

Archive parser supports ZIP stored and deflate entries. It intentionally rejects encrypted and ZIP64 archives.

Scene decoding uses MIT-licensed [`kiwi-schema`](https://www.npmjs.com/package/kiwi-schema), compiled from schema embedded in each input file. No network request occurs while inspecting or decoding a `.fig` file.
