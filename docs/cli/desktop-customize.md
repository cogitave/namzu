---
type: Reference
title: Customize in Desktop
description: The Customize page in the Desktop app (Skills, Connectors and Plugins tabs, a skill's detail with Overview and Contents, a plugin's detail, the connectors table, the ways in from the rail, slash commands and cards, and the host methods the page reads).
resource: packages/desktop/src/renderer/customize-page.tsx
tags: [desktop, skills, plugins, connectors, jsonrpc]
status: stable
generated: { by: process:agent, at: 2026-11-27T00:00:00Z }
---

# Customize in Desktop

**Customize** is one full page for what Namzu can do beyond its defaults: its skills, its connectors
(tool servers) and its plugins. It replaces the Plugins page and that page's own sidebar. The
normal sidebar stays; choosing a conversation leaves the page.

## Ways in

- The **Customize** button, beside Extensions and Settings, in the rail and in the sidebar's foot.
- `/plugins` in the message box opens it on **Plugins**. `/mcp`, and the composer's tool-server
  "manage" link, open it on **Connectors**.
- The link on the saved-skill card, **Open in Customize**, opens it on **Skills**.
- Settings, Desktop app, **Plugins**, opens it on **Plugins**.

The tab left last is kept for as long as the window lives.

## The page

The title, Customize, is set in the document face at 28 px. The column is 960 px at most, centred,
with 32 px at each side. One row sits under the title: the tabs **Skills | Connectors | Plugins**,
and on the right a search field, a **Sort** button (Skills and Plugins; by name or by last
updated) and **Add**. In a window about 900 px wide the controls wrap under the tabs and nothing
spills sideways.

There is no Yours/Discover switch. Namzu has no catalogue of skills or plugins to discover, so the
switch would have one side.

### Skills

Groups in this order, each with a count: **This project**, **Yours**, **From plugins** and
**Built-in**. A row is 63 px: the name, small chips (the plugin's name for a plugin's skill;
**Name only**, **You only** or **Off** when the skill is not simply on), then `place · description`
and the time it was last changed (**3d ago**, or **Nov 19** after a week; none for a built-in skill,
whose file says only when Namzu was installed). **Off** rows show their name in the muted colour.
The **⋯** menu holds **Turn off** or **Turn on**; a plugin's skill has no menu, because it follows
its plugin. **Add** holds **Create with Namzu**, which starts the same conversation as Settings'
*Create skill*. With no skill, the page says where to put one (`.namzu/skills/`,
`~/.namzu/skills/`).

Pressing a row opens the skill. The header has **Try in chat** (a new conversation with
`/<name> ` in the box, not sent), a menu and a switch. The switch writes `skills.disabled`, the
setting Settings' switch writes, so Settings, the terminal's `/skills` and this page agree. A skill
the terminal set to name only or user only is shown on, with the note that says where it was set;
this page does not change that. **Overview** shows the uses in the last seven days, when it was last
used, the description and the folder (with `~` for home). **Contents** shows the folder's files in a
tree and one file at a time, read-only: Markdown is rendered (its settings block left out), with a
switch to the source; any other text file is plain monospace; a binary file or one over 256 KiB is
refused or cut, and the viewer says so. Escape goes back to the list.

An engine that does not offer the catalog (an older program) is read through the installed-skills
list: names and places only, no times, uses or Contents.

### Connectors

A table: **Connector | Type | Source | Status**. The rows are the open project's tool servers
(which include the ones in your own settings), or your own servers alone when no project is open.
**Type** is *Local* for a command and *Remote* for an address. **Source** says where it is set
(*Your own settings*, *This project's settings*, *.mcp.json in this project*). **Status** is a tick
for connected, **Approve** for a server waiting for approval (the same approval as Settings, Tools),
**Failed** with the reason in its tooltip, or a dash. A row opens Settings, Tools, on the tool
servers; **Add**, **Add custom connector**, opens the same place with the add form open.

### Plugins

**Installed**, with a count. A row shows the name, a version chip, an **Off** chip, `user` or
`project · description` and the time of the manifest. The **⋯** menu holds **Turn off** or **Turn
on**, and **Details**. A change needs a running conversation and is refused while it works; the page
says so in the words the old page used. The detail has **Overview** (description and the
information: installation, version, author, status, whether it starts next time, a start-up
error), **Skills** (each skill as `/name` with its description) and **Connectors** (the server
names). Namzu has no install, update or remove verbs for plugins, so none is offered. With no
plugin, the page says where they live (`.namzu/plugins/`, `~/.namzu/plugins/`).

## What the page reads

The page reaches the engine only through the host methods in the table of
[Desktop](desktop.md): `namzu/skills/catalog`, `namzu/skills/files`, `namzu/skills/read_file`,
`namzu/plugins/list`, `namzu/mcp/servers` and `namzu/plugins/set_enabled`, behind the capability
group `skillsCatalog`. Every answer is read through `shared/customize-protocol.ts`, which keeps the
shape it expects, caps the counts and lengths and drops the rest.
