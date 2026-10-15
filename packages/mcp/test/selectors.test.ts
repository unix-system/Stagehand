import { describe, expect, it } from "vitest";
import { formatSelector, parseSelector, SelectorError } from "../src/spec/selectors.js";

describe("selector parser", () => {
  it.each([
    ["Workspace.Map.Spawns.Blue", { kind: "path", all: false }],
    ["game.ReplicatedStorage.Remotes", { kind: "path", all: false }],
    ["Lighting", { kind: "path", all: false }],
    ["@p1", { kind: "actor", actor: "p1", root: null }],
    ["@p1.player", { kind: "actor", root: "player" }],
    ["@p1.character", { kind: "actor", root: "character" }],
    ["@p1.character.HumanoidRootPart", { kind: "actor", root: "character" }],
    ["@p1.gui.Menu.Spawn", { kind: "actor", root: "gui" }],
    ["@blue.backpack.Gun", { kind: "actor", actor: "blue", root: "backpack" }],
    ["tag:Hostile", { kind: "tag", tag: "Hostile", all: false }],
    ["tag:Hostile[]", { kind: "tag", tag: "Hostile", all: true }],
    ["tag:Has Space", { kind: "tag", tag: "Has Space" }],
    ["$target", { kind: "var", name: "target" }],
    ["Workspace.Enemies.*", { kind: "path" }],
    ["Workspace.Map.Lamps.*[]", { kind: "path", all: true }],
    ["Workspace.**.Spawn", { kind: "path" }],
    ["Workspace.'Blue Spawn'", { kind: "path" }],
  ])("parses %s", (input, shape) => {
    expect(parseSelector(input)).toMatchObject(shape);
  });

  it("strips the game. prefix and keeps segments", () => {
    const s = parseSelector("game.ReplicatedStorage.Remotes");
    expect(s.kind === "path" && s.segments.map((x) => x.name)).toEqual(["ReplicatedStorage", "Remotes"]);
  });

  it("parses wildcards", () => {
    const s = parseSelector("Workspace.**.Spawn");
    expect(s.kind === "path" && s.segments.map((x) => x.wildcard ?? x.name)).toEqual(["Workspace", "**", "Spawn"]);
  });

  it("parses filters with typed literals and attributes", () => {
    const s = parseSelector("Workspace.*[@Team=Red,Health=100,Alive=true]");
    expect(s.kind).toBe("path");
    if (s.kind !== "path") return;
    expect(s.segments[1]!.filter).toEqual([
      { attribute: true, key: "Team", value: "Red" },
      { attribute: false, key: "Health", value: 100 },
      { attribute: false, key: "Alive", value: true },
    ]);
    const n = parseSelector("Workspace.Enemies[Name=Boss]");
    expect(n.kind === "path" && n.segments[1]).toMatchObject({ name: "Enemies", filter: [{ key: "Name", value: "Boss" }] });
  });

  it("parses quoted names containing dots", () => {
    const s = parseSelector("Workspace.'Spawn.Blue'.Pad");
    expect(s.kind === "path" && s.segments.map((x) => x.name)).toEqual(["Workspace", "Spawn.Blue", "Pad"]);
  });

  it.each([
    "",
    "Workspace..Part",
    "Workspace.Part.",
    "@p1.weapon",
    "@",
    "$",
    "$1abc",
    "tag:",
    "Workspace.My Part",
    "Workspace.'unterminated",
    "Workspace.*[Team]",
    "Workspace.*[Team=Red",
    "Workspace.*[]x",
    "[]",
  ])("rejects %j", (input) => {
    expect(() => parseSelector(input)).toThrow(SelectorError);
  });

  it("round-trips through formatSelector", () => {
    for (const s of ["Workspace.Map.Lamps.*[]", "@p1.character.HumanoidRootPart", "tag:Lit[]", "$x", "Workspace.'Blue Spawn'", "Workspace.*[@Team=Red,Health=100]"]) {
      expect(formatSelector(parseSelector(s))).toBe(s);
    }
  });
});
