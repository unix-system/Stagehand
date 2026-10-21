# Site vocabulary and grammar review

Review date: 2026-10-21.
Reference: [ASD-STE100 Issue 9](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf), Part 1 and Part 2.

## Scope and method

The review covers the homepage, quickstart, game hooks, writing guide, specification, MCP tools, plugin, protocol, and generated reference descriptions.
It also includes the site title, navigation, and footer.
The review compared vocabulary candidates with the dictionary's part of speech, meaning, and alternatives.
It distinguished general vocabulary from computing terms permitted by Rules 1.5 and 1.12.
The grammar review covered verb forms, voice, action phrases with "-ing", articles, repeated words, and paragraph structure.

This is an editorial review, not independent certification or a full conformance assessment.
The standard does not supply a simple percentage score for this site.
The sentence-length percentage cannot establish the requested 75% vocabulary or grammar compliance.
Do not report a full STE compliance percentage from the automated checks.

## Corrections

| Area | Finding | Correction |
| --- | --- | --- |
| Dictionary; Rules 1.2–1.3 | CHECK used as a verb | Use "make sure", "examine", "validate", or "do a check", according to the operation. Keep CHECK as a noun. |
| Dictionary; Rule 1.2 | DISPLAY used as a verb | Use "show". Keep "display" as a noun. |
| Dictionary; Rule 1.2 | COMPLETE used as an adjective | Use "full". Keep "complete" as a verb. |
| Dictionary | "require", "concurrently", "therefore", "alternatively", "remain" | Use "need", "at the same time", "thus", "as an alternative", and "stay", according to context. |
| Dictionary | "within" in time limits and locations | Use "in ... or less", "before the time limit", or "in". Keep the `within` API identifier. |
| Dictionary | "visible" in condition descriptions | Describe an object in view. Keep the `Visible` property and `gui.visible` identifier. |
| Rules 3.2–3.6 | Perfect/progressive forms and unnecessary passive voice | Use simple forms; identify the node, daemon, or tool that does the operation. |
| Rule 3.5 | "after copying", "before using", "without saving" | Use clauses such as "after you copy" and "before you save". |
| Rules 4.2, 4.5 | Missing articles, duplicate "a a", abbreviated procedure prose | Add articles, remove the duplicate, and use full sentences where the reader must do an action. |
| Rule 6.6 | Paragraphs with more than six sentences | Split long descriptions; link to the error table instead of repeating all error definitions. |
| Rules 1.10–1.11 | Informal terms such as "drive Studio", "on the wire", and "in flight" | Use "use Studio", "in HTTP messages", and "active". |

The reference generator now supports separate parameter descriptions for the site.
Each replacement records the exact catalog source, so a catalog change forces another review.
The generator keeps the original JSON schemas in code blocks.

## Technical terminology

These terms have specific software meanings. They are not general-word exemptions in all contexts.
Use the listed role and meaning. Prefer an approved general word when it expresses the same operation accurately.
Capitalized product names and Roblox class names retain their official spelling.

| Term or group | Role | Meaning in this site |
| --- | --- | --- |
| playtest, test run, run | Noun | A recorded execution of a game's test steps; a run has an ID and reports. |
| run | Technical verb | Execute software, a test, or a test step. Do not use it to describe physical movement or equipment operation. |
| coding agent, MCP, daemon, broker, client, server, node | Technical nouns | Software components or their communication protocol. A node represents a Studio DataModel. |
| action, condition, actor, selector, modifier, fragment, hook | Technical nouns | Stagehand concepts defined in the guides and specification. |
| parameter, argument, schema, namespace, property, attribute, callback, coroutine | Technical nouns | Parts of the API, its data, or program execution. |
| branch, context, state, session, teardown, reset policy | Technical nouns | Parts of test execution and its lifecycle. |
| return, call, register, bind, compile, serialize, reset, reuse, define | Technical verbs | Pass a result to a caller; invoke a function; add a named hook; connect values; translate code; encode data; set initial state; use an existing session again; declare a data structure. |
| create | Technical verb | Allocate a software object, player character, node, or script. Use "make" for general prose where appropriate. |
| validate | Technical verb | Compare data with schema or catalog rules. This does not mean that a gameplay test passed. |
| copy, save, store, delete, click, load, install, download, enable, disable | Technical verbs | Computing operations covered by Rule 1.12. |
| build, checkout, repository, artifact, plugin, module, package | Technical nouns; build also a technical verb | Source and distribution objects, or translation of source into an executable artifact. |
| polling, debugging, mapping, routing, grouping | Technical nouns | Named computing processes; not permission to use progressive verbs everywhere. |
| truthy, falsy, boolean, null, integer, string, enum | Technical terms | Data types or language truth-value categories. "True" does not mean an editorial guarantee. |
| GUI, cursor, viewport, widget, overlay, focus, frame | Technical nouns | Interface or rendering objects and state. |
| spawn, respawn, equip, unequip, teleport | Technical verbs | Roblox character and tool operations. |
| replication, remote, bridge, DataModel, Instance, Player | Technical nouns | Roblox runtime objects and communication mechanisms. |

## Deliberate boundaries

- Preserve code examples, literals, paths, schema keys, API names, and raw catalog JSON. They are quoted technical artifacts.
- Preserve exact UI labels, including **Allow**, **Run**, **Starting session**, and **MINE / ALL**.
- Keep conventional navigation labels, such as **Getting Started**, and product names.
- Reference tables contain data labels and fragments. They are not all imperative instructions.
- Historical architecture and implementation documents are outside the published site and this review.

## Repeatable checks

`pnpm docs:language` checks selected vocabulary and grammar patterns in prose, table cells, and homepage text.
It excludes fenced code and inline literals. Link labels remain in scope; link destinations do not.
The script reports the sentence-length measure separately from vocabulary and grammar findings.
The regression tests include valid noun uses and code exclusions to limit false positives.

A successful check means that these specific patterns did not occur.
It does not prove that every word has an approved meaning or that every sentence meets every rule.
Review new prose against the official reference and this terminology record before publication.
