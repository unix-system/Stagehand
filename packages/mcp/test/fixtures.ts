// The three docs/spec.md examples, verbatim.
export const BLUE_TEAM = `name: blue-team-gun-hostile
description: Blue spawn → equip gun → Hostile tag appears
tags: [smoke, combat]
session: { mode: play, players: 1 }
vars:
  spawn: [120, 5, -40]
steps:
  - { do: player.setTeam,      as: p1, team: Blue }
  - { do: game.requestSpawn,   as: p1 }
  - { wait: character.loaded,  as: p1, timeout: 10s }
  - { do: character.teleport,  as: p1, to: $spawn }
  - { do: character.equipTool, as: p1, tool: Gun }
  - { expect: instance.hasTag, target: "@p1.character", tag: Hostile, within: 2s }
teardown:
  - { do: character.unequip, as: p1, soft: true }
`;

export const NIGHT_MODE = `name: night-mode-toggle
tags: [smoke]
session: { players: 0 }          # → mode: run
steps:
  - { do: instance.set, target: Lighting, prop: ClockTime, value: 0 }
  - { expect: instance.property, target: Lighting, prop: ClockTime, op: eq, value: 0 }
  - { do: instance.setAttribute, target: Workspace.Map, name: Night, value: true }
  - { wait: instance.hasTag, target: "Workspace.Map.Lamps.*[]", tag: Lit, timeout: 3s }
  - { lua: "return #game:GetService('CollectionService'):GetTagged('Lit')", label: count lamps, save: lit }
  - { expect: lua, code: "return vars.lit > 0" }
  - { expect: log.noErrors }
`;

export const TWO_PLAYER = `name: two-player-teams
tags: [multiplayer]
session: { players: 2, reset: respawn }
actors:
  blue: { player: 1 }
  red:  { player: 2 }
steps:
  - { do: player.setTeam, as: blue, team: Blue }
  - { do: player.setTeam, as: red,  team: Red }
  - each:
      actors: [p1, p2]
      steps:
        - { do: player.respawn }
        - { wait: character.loaded, timeout: 15s }
        - { expect: character.alive }
  - parallel:
      - - { do: character.jump, as: p1 }
        - { wait: character.near, as: p1, to: [0, 5, 0], radius: 50 }
      - - { do: input.move, as: p2, direction: [0, 0, -1], duration: 1s }
  - { expect: player.count, op: eq, value: 2 }
  - { expect: player.onTeam, as: red, team: Red }
  - { expect: gui.visible, as: p2, target: "@p2.gui.TeamBadge", within: 2s }
`;
