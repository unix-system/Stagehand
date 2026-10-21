---
layout: home
title: Automatic playtests for Roblox Studio
hero:
  name: Stagehand
  text: Automatic playtests for Roblox Studio.
  tagline: Write test steps in YAML. Use your coding agent to run them in Studio. Read the results for each step.
  image:
    src: /logo.svg
    alt: Stagehand theatrical lantern
  actions:
    - theme: brand
      text: Get Started
      link: /quickstart
    - theme: alt
      text: Read on GitHub
      link: https://github.com/unix-system/Stagehand
features:
  - title: Write test steps
    details: Select player actions. Add conditions to examine the results. Save the YAML files in your game project.
    link: /writing-tests
    linkText: Write a playtest
  - title: Run tests from your agent
    details: The MCP server connects your coding agent to Studio. It reports step results, error details, and logs.
    link: /mcp
    linkText: Connect your agent
  - title: Call game functions
    details: Use game hooks to call functions in your game. A hook can create a player character or reset a match.
    link: /game-hooks
    linkText: Add game hooks
---

<p class="eyebrow">Do. Wait. Expect.</p>

## Example playtest

This playtest uses the sample game in the repository. It assigns a team to a player and creates the player character.
It then equips a tool and does a check for a tag. The sample game supplies the `game.requestSpawn` hook.

```yaml
name: blue-team-gun-hostile
session: { mode: play, players: 1 }
steps:
  # Set the team and create the player character.
  - { do: player.setTeam, as: p1, team: Blue }
  - { do: game.requestSpawn, as: p1 }

  # Wait until the character is loaded.
  - { wait: character.loaded, as: p1, timeout: 10s }
  - { do: character.equipTool, as: p1, tool: Gun }

  # Allow up to two seconds for the tag to appear.
  - { expect: instance.hasTag, target: "@p1.character", tag: Hostile, within: 2s }
```

### How Stagehand runs a test

Your coding agent sends the playtest to the Stagehand MCP server.
The Studio plugin does each step on an edit, server, or client node.
The plugin reports the result of each step.
If a step fails, the report includes the cause and available logs.
The report also includes expected and actual values when available.

[Run your first playtest](quickstart.md) · [Read the action and condition reference](reference/index.md)
