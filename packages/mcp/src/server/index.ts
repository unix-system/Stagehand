// MCP server assembly.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BROKER_VERSION } from "../broker/protocol.js";
import type { Daemon } from "../daemon.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";

export const SERVER_INSTRUCTIONS = `Stagehand runs declarative playtests (YAML) inside Roblox Studio.
Typical flow: stagehand_status -> list_actions -> inspect -> validate_test -> run_steps -> save_test -> run_test / run_suite.
Failures report the failing step with reason, expected and actual values and the Output logs around it.
Use Stagehand for repeatable tests, not one-off debugging: to run a snippet, read state or inspect instances once,
use a Studio MCP (roblox-assistant, Roblox Studio MCP) instead of starting a session or calling eval_lua.`;

export function createMcpServer(d: Daemon): McpServer {
  const server = new McpServer(
    { name: "stagehand", version: BROKER_VERSION },
    { capabilities: { logging: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, d);
  registerResources(server, d);
  registerPrompts(server);
  return server;
}
