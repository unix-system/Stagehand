---
layout: home
title: Playtests, ready for their cue
hero:
  name: Stagehand
  text: Give your game a proper rehearsal.
  tagline: Write the steps. Let your coding agent run them in Roblox Studio. Know exactly where the scene went wrong.
  image:
    src: /logo.svg
    alt: Stagehand theatrical lantern
  actions:
    - theme: brand
      text: Get Started
      link: /quickstart
    - theme: alt
      text: View on GitHub
      link: https://github.com/unix-system/Stagehand
features:
  - title: Small scripts. Clear expectations.
    details: Describe player actions, wait for the game to react, and assert the result. Keep readable YAML playtests beside your game.
    link: /writing-tests
    linkText: Write a playtest
  - title: Your agent runs the rehearsal.
    details: An MCP server connects your coding agent to Studio, with live step reports, captured logs, and the context behind a failure.
    link: /mcp
    linkText: Connect your agent
  - title: Your game knows its own cues.
    details: Expose real game logic as named actions and conditions. Spawn a player, reset a round, or check match state through game hooks.
    link: /game-hooks
    linkText: Add game hooks
---

<p class="eyebrow">Do. Wait. Expect.</p>

## A scene you can run again.

Put a player on a team, request a spawn, and check what happens when they equip a tool.
This playtest runs against the repository's sample game; `game.requestSpawn` is a hook supplied by that game.

```yaml
name: blue-team-gun-hostile
session: { mode: play, players: 1 }
steps:
  # Set the scene using built-in actions and a game hook.
  - { do: player.setTeam, as: p1, team: Blue }
  - { do: game.requestSpawn, as: p1 }

  # Wait for the character instead of guessing a sleep duration.
  - { wait: character.loaded, as: p1, timeout: 10s }
  - { do: character.equipTool, as: p1, tool: Gun }

  # Check the observable result, with time for the game to react.
  - { expect: instance.hasTag, target: "@p1.character", tag: Hostile, within: 2s }
```

### From a step to a result

Your coding agent sends the playtest to the Stagehand MCP server. The Studio plugin runs each step on the appropriate edit, server, or client node and reports its outcome. When a step fails, the report includes the reason and available expected/actual values and logs.

[Run your first playtest →](quickstart.md) · [Explore actions and conditions →](reference/index.md)
