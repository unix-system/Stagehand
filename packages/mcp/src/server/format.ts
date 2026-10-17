// Text formatting helpers for MCP tool results.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StagehandError } from "../broker/protocol.js";
import { type CatalogEntry, type JsonSchema, paramTypeText } from "../spec/catalog.js";
import { collidingParams } from "../spec/modifiers.js";

export function text(s: string): CallToolResult {
  return { content: [{ type: "text", text: s }] };
}

export function json(v: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(v, null, 2) }] };
}

export function fail(e: unknown, hint?: string): CallToolResult {
  const err = StagehandError.from(e);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: err.toObject(), ...(hint ? { hint } : {}) }, null, 2) }],
  };
}

export function entryLine(e: CatalogEntry): string {
  const props = (e.params?.properties as Record<string, JsonSchema> | undefined) ?? {};
  const req = new Set((e.params?.required as string[] | undefined) ?? []);
  const params = Object.entries(props).map(([k, ps]) => {
    const def = ps.default !== undefined ? `=${JSON.stringify(ps.default)}` : "";
    return `${k}${req.has(k) ? "" : "?"}: ${paramTypeText(ps)}${def}`;
  });
  const open = e.params?.additionalProperties !== false && Object.keys(props).length === 0 ? "any params" : params.join(", ");
  const ctx = e.contexts.map((c) => (c === e.default ? `${c}*` : c)).join("|");
  const actor = e.actor === "required" ? " needs-as" : e.actor === "optional" ? " as?" : "";
  const collide = collidingParams(e.params);
  const collideNote = collide.length ? ` NOTE: param(s) ${collide.join(", ")} share a name with step modifiers; pass them under with: { … }.` : "";
  return `${e.name} [${e.kind}] (${ctx})${actor} {${open}}: ${e.summary}${e.notes ? ` NOTE: ${e.notes}` : ""}${collideNote}${e.returns ? " (save-able return)" : ""}`;
}

export const SPEC_CHEATSHEET = `Step syntax: one verb per step: do: <action> | wait: <condition> | expect: <condition> | lua: "<code>" | parallel: [branches] | each: {actors, steps} | use: <fragment> (a named step list from fragments: or playtests/_shared/<name>.fragment.yaml; see list_tests).
Flat params next to the verb, e.g. { do: character.teleport, as: p1, to: [0, 5, 0] }; use with: {...} for params named like modifiers.
Modifiers: as (actor p1..pN or alias), on (edit|server|client), timeout (default 10s), within (expect only), soft, label (recommended on every lua step: it names the step in reports and the Studio widget), save (do/lua), if: "$var".
Values: Vector3 = [x,y,z]; durations "250ms" | "10s" | "1.5m" | seconds; "$name" = var (whole value).
Selectors: Workspace.Map.Part, @p1.character.HumanoidRootPart, @p1.gui.Menu.Play, @p1.backpack.Gun, tag:Enemy, tag:Enemy[] (all), Workspace.Enemies.*[], Workspace.**.Spawn, Workspace.*[@Team=Red], 'Name With Spaces'.
op (for compare conditions): eq ne gt gte lt lte contains matches (Lua pattern).
Contexts: (edit|server*|client) lists where an entry can run; * = default. needs-as = requires \`as:\` when players >= 2 (defaults to p1 with 1 player).
game.* entries come from the game's Hooks.server{}/Hooks.client{} and appear once a session is running.`;
