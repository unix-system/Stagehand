// MCP resources: stagehand://catalog, stagehand://tests/{name}, stagehand://runs/latest.
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Daemon } from "../daemon.js";

export function registerResources(server: McpServer, d: Daemon): void {
  server.registerResource(
    "catalog",
    "stagehand://catalog",
    { title: "Stagehand catalog", description: "Merged action/condition catalog (static + live game.* hooks)", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ version: d.catalog.file.version, ops: d.catalog.ops, contexts: d.catalog.file.contexts, entries: d.catalog.entries() }, null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "tests",
    new ResourceTemplate("stagehand://tests/{name}", {
      list: async () => ({
        resources: (await d.tests.list()).map((t) => ({
          uri: `stagehand://tests/${t.name}`,
          name: t.name,
          description: t.description ?? undefined,
          mimeType: "application/yaml",
        })),
      }),
      complete: { name: async (v) => (await d.tests.list()).map((t) => t.name).filter((n) => n.startsWith(v ?? "")) },
    }),
    { title: "Saved playtests", description: "playtests/<name>.playtest.yaml", mimeType: "application/yaml" },
    async (uri, vars) => {
      const name = String(Array.isArray(vars.name) ? vars.name[0] : vars.name);
      const t = await d.tests.get(name);
      if (!t) throw new Error(`no saved test "${name}"`);
      return { contents: [{ uri: uri.href, mimeType: "application/yaml", text: t.text }] };
    },
  );

  server.registerResource(
    "latest-run",
    "stagehand://runs/latest",
    { title: "Latest run", description: "Result JSON of the most recent run", mimeType: "application/json" },
    async (uri) => {
      const live = d.runs.get("latest");
      const r = live?.result ?? (live ? live.summary() : await d.runsStore.latest());
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(r ?? null, null, 2) }] };
    },
  );
}
