// MCP prompt: write_playtest.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function writePlaytestPrompt(goal: string, name?: string): string {
  return `Write a Stagehand playtest for this Roblox game behaviour:

${goal}

Workflow:
1. Call stagehand_status to confirm Studio is attached.
2. Call list_actions (and list_actions with name: <entry> for details) to see available actions/conditions and step syntax.
3. Call inspect to discover real instance paths (teams, remotes in ReplicatedStorage, tools, GUI under @p1.gui, tags). Never guess paths.
4. Draft the playtest YAML${name ? ` named "${name}"` : ""}:
   - name: kebab-case; session: { players: N } (0 = no characters / Run mode, 1 = Play, 2+ = multiplayer).
   - steps: one verb per step (do / wait / expect / lua / parallel / each / use), flat params, as: p1 for the player.
   - prefer wait:/expect ... within: over fixed sleeps; use teardown with soft: true for cleanup.
   - give every lua step a label: ("count lamps", "menu is open") — it is the step's name in reports and the Studio widget.
   - a step sequence that several tests repeat (spawning through a menu, logging in) belongs in a fragment: fragments: { name: [steps] } in the file, or playtests/_shared/<name>.fragment.yaml for all tests, then { use: name, as: p1 }.
5. Call validate_test with the YAML and fix every error.
6. Call run_steps (or run with the full document) and iterate until it passes; read failures' expected/actual and logs.
7. Call save_test to store it in playtests/.

Example:
\`\`\`yaml
name: blue-team-gun-hostile
session: { mode: play, players: 1 }
vars: { spawn: [120, 5, -40] }
steps:
  - { do: player.setTeam, as: p1, team: Blue }
  - { wait: character.loaded, as: p1, timeout: 10s }
  - { do: character.teleport, as: p1, to: $spawn }
  - { do: character.equipTool, as: p1, tool: Gun }
  - { expect: instance.hasTag, target: "@p1.character", tag: Hostile, within: 2s }
teardown:
  - { do: character.unequip, as: p1, soft: true }
\`\`\``;
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "write_playtest",
    {
      title: "Write a playtest",
      description: "Guide for drafting, validating, running and saving a Stagehand playtest",
      argsSchema: {
        goal: z.string().describe("Behaviour to test, in plain words"),
        name: z.string().optional().describe("Test name (kebab-case)"),
      },
    },
    ({ goal, name }) => ({
      messages: [{ role: "user", content: { type: "text", text: writePlaytestPrompt(goal, name) } }],
    }),
  );
}
