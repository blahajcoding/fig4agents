# Local Figma Files

Use local `fig` CLI for `.fig` files. Do not require Figma MCP, browser access, or API credentials.

```bash
bun run fig -- inspect "file.fig"
bun run fig -- search "file.fig" "query"
bun run fig -- scene "file.fig"
bun run fig -- export-scene "file.fig" ./scenegraph.json
bun run fig -- export-assets "file.fig" ./assets
FIGMA_TOKEN="$FIGMA_TOKEN" bun run fig -- fetch "https://www.figma.com/design/FILE_KEY/..." ./scenegraph.json
```

Workflow:

1. Run `inspect` before interpreting file contents.
2. Use `scene` for page names, node counts, and node types.
3. Use `export-scene` when parent/child relationships are needed.
4. Use `search` for names, labels, text, node IDs, and design-token evidence.
5. Use `export-assets` when visual/image assets matter.

`canvas.fig` uses Figma's Kiwi codec. Current local reader decodes framing, embedded schema, Zstandard document payload, scenegraph hierarchy, metadata, thumbnail, and assets. Geometry and style fields are intentionally omitted from normalized scene output until field contract tests cover them.

First `scene` or `export-scene` call generates a local decoder under `.fig-local-cache/`. This is offline after project dependencies are installed.

Use `fetch` only when caller has supplied `FIGMA_TOKEN`. Never print, persist, or add token to commands/config files.
