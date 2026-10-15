#!/usr/bin/env node
// stagehand-mcp: HTTP broker for Studio nodes + MCP server over stdio.
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_PORT } from "./broker/protocol.js";
import { Daemon } from "./daemon.js";
import { parseDuration } from "./spec/values.js";
import { createMcpServer } from "./server/index.js";
import { cliRun } from "./cli/run.js";

const HELP = `stagehand-mcp [options]

  --root <dir>          project dir (tests in <root>/playtests, runs in <root>/.stagehand/runs; default cwd)
  --port <n>            broker port (default $STAGEHAND_PORT or ${DEFAULT_PORT})
  --allow-eval          enable the eval_lua tool
  --idle-timeout <dur>  end idle Studio sessions after this long (default 120s; 0 = never)
  --broker-only         run only the HTTP broker (no MCP stdio), for debugging
  --run <name>          run the saved playtest <name> and exit (repeatable; no MCP). Exit code:
                        0 all passed, 1 a test failed/errored, 2 setup problem (unknown test, no Studio)
  --wait-for-studio <dur>  how long --run waits for a Studio edit node (default 300s)
  --launch-timeout <dur>   Studio session launch timeout (default 120s; 300s with --run)
  --timeout <dur>       --run: override each test's whole-run timeout
  --json                --run: print one JSON document instead of markdown reports
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
      "allow-eval": { type: "boolean", default: false },
      "idle-timeout": { type: "string" },
      "broker-only": { type: "boolean", default: false },
      run: { type: "string", multiple: true },
      "wait-for-studio": { type: "string" },
      "launch-timeout": { type: "string" },
      timeout: { type: "string" },
      json: { type: "boolean", default: false },
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
  const runNames = values.run ?? [];
  const sessions: { idleTimeoutMs?: number; launchTimeoutMs?: number } = {};
  if (values["idle-timeout"] !== undefined) sessions.idleTimeoutMs = parseDuration(numOrDur(values["idle-timeout"]));
  if (values["launch-timeout"] !== undefined) sessions.launchTimeoutMs = parseDuration(numOrDur(values["launch-timeout"]));
  else if (runNames.length) sessions.launchTimeoutMs = 300_000;
  const daemon = new Daemon({
    root: values.root ?? process.cwd(),
    port,
    allowEval: values["allow-eval"],
    sessions: Object.keys(sessions).length ? sessions : undefined,
  });
  await daemon.start().catch(() => {
    /* reported via stagehand_status; MCP keeps serving offline tools */
  });
  if (runNames.length) {
    const ctrl = new AbortController();
    process.on("SIGINT", () => ctrl.abort());
    process.on("SIGTERM", () => ctrl.abort());
    const code = await cliRun(daemon, {
      names: runNames,
      waitForStudioMs: parseDuration(numOrDur(values["wait-for-studio"] ?? "300s")),
      timeoutMs: values.timeout !== undefined ? parseDuration(numOrDur(values.timeout)) : undefined,
      json: values.json,
      signal: ctrl.signal,
    });
    await daemon.stop().catch(() => {});
    process.exit(code);
  }
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
