#!/usr/bin/env node
// stagehand-mcp: HTTP broker for Studio nodes + MCP server over stdio.
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_PORT, PORT_RANGE } from "./broker/protocol.js";
import { Daemon } from "./daemon.js";
import { parseDuration } from "./spec/values.js";
import { createMcpServer } from "./server/index.js";

const HELP = `stagehand-mcp [options]

  --root <dir>          project dir (tests in <root>/playtests, runs in <root>/.stagehand/runs; default cwd)
  --port <n>            start of the broker port range (default $STAGEHAND_PORT or ${DEFAULT_PORT}); the first free of n..n+${PORT_RANGE - 1} is used
  --place <id|name>     Studio to drive when several are open: placeId or a substring of the place name (default $STAGEHAND_PLACE)
  --allow-eval          enable the eval_lua tool
  --idle-timeout <dur>  end idle Studio sessions after this long (default 120s; 0 = never)
  --broker-only         run only the HTTP broker (no MCP stdio), for debugging
  -h, --help
`;

function numOrDur(v: string): string | number {
  return /^\d+(\.\d+)?$/.test(v) ? Number(v) : v;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      port: { type: "string" },
      place: { type: "string" },
      "allow-eval": { type: "boolean", default: false },
      "idle-timeout": { type: "string" },
      "broker-only": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stderr.write(HELP);
    return;
  }
  const port = Number(values.port ?? process.env.STAGEHAND_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port ${values.port}`);
  const daemon = new Daemon({
    root: values.root ?? process.cwd(),
    port,
    place: values.place ?? process.env.STAGEHAND_PLACE,
    allowEval: values["allow-eval"],
    sessions: values["idle-timeout"] !== undefined ? { idleTimeoutMs: parseDuration(numOrDur(values["idle-timeout"])) } : undefined,
  });
  await daemon.start().catch((e) => {
    // also reported via stagehand_status; MCP keeps serving offline tools
    process.stderr.write(`stagehand-mcp: broker not listening: ${daemon.brokerError ?? (e as Error).message}\n`);
  });
  if (values["broker-only"]) return;
  const server = createMcpServer(daemon);
  await server.connect(new StdioServerTransport());
  const shutdown = async () => {
    await daemon.sessions.end("daemon shutdown").catch(() => {});
    await daemon.stop().catch(() => {});
    process.exit(0);
  };
  process.stdin.on("close", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  process.stderr.write(`stagehand-mcp: ${(e as Error).message}\n`);
  process.exit(1);
});
