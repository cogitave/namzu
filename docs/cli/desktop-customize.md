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
The **⋯** menu holds **Turn off** or **Turn on** and, for a skill of your own or the project's,
**Remove** (see below); a plugin's skill has no menu, because it follows its plugin. **Add** holds
**Upload skill**, **Create a skill** and **Create with Namzu**, which starts the same conversation
as Settings' *Create skill*; an engine that cannot add skills hides the first two. There is no
*Record your screen* entry. With no skill, the page says where to put one (`.namzu/skills/`,
`~/.namzu/skills/`).

Pressing a row opens the skill. The header has **Try in chat** (a new conversation with
`/<name> ` in the box, not sent), a menu and a switch. The switch writes `skills.disabled`, the
setting Settings' switch writes, so Settings, the terminal's `/skills` and this page agree. A per-project
state from the terminal's `/skills` screen (`skills.overrides`) wins over that list, so a skill
whose state the list alone would not give (name only, user only, or off or on by an override) has
its switch and menu locked, with a note that says where it was set; this page does not change it. **Overview** shows the uses in the last seven days, when it was last
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
servers; **Add**, **Add custom connector**, opens a dialog (see below) when the engine reads your
own servers, and otherwise the same place with the add form open.

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

## Adding, making and removing: the page

- **Upload skill** replaces the list with a page (**← Your skills**, **Upload a skill**, *Add a
  skill to this computer.*). A drop zone (*Drag and drop skill files here, or browse. You can add
  several at once.*) with **browse** (the file dialog) and **Choose a folder**, the two help lines
  about `.md` and `.zip` or `.skill` files, **Where to save** (**Yours** or **This project**; the
  second is off, with the reason, until a trusted folder is open), the line *Each skill is checked
  when you add it...*, **Upload** (off until something valid is chosen, with the hint *Choose a
  file to continue.*) and **Cancel**. Choosing files stages them: one card per file with the name,
  the description, `3 files · 12 KB`, chips (**Runs commands**, **Uses tools: shell**, **Has
  hooks**), what it can run or pre-approve, what was changed or left out, a refusal in words when
  it cannot be added, and **Remove from list**. A name that the chosen place already holds shows a
  checkbox *Replaces your skill "x"* that must be ticked; a skill that can run something shows *I
  trust what it can run* that must be ticked, because the engine refuses it otherwise. Upload
  answers with a toast (*Added 2 skills. They are available from your next message.*), or keeps
  the failed cards with the engine's reason on each.
- **Create a skill** is a dialog: **Skill name** (the folder name derived from it shows under it
  and is what is saved: lower case, words joined by dashes), **Description** with a counter
  (`n/1024`; XML tags are refused), **Instructions** (monospace; a leading `---` is flagged) and
  **Where to save**. **Create** stays off until the name and description are valid. A name that is
  taken says *You already have a skill named "x".* and offers **Replace**. On success the new skill
  opens. No model is involved. There is no attached-files list: an optional **Add file** (extra files beside `SKILL.md`) was left out on purpose, and `namzu/skills/create` takes no files; a skill with extra files is added with **Upload skill**. Whatever keeps **Create** off is written beside it (*Add a valid name and description before saving.*, *Write what the skill should do.*, the length limit, XML tags), and a disabled primary button is drawn flat and muted so it does not read as live.
- **Remove** in a row's menu (user and project skills only) asks **Remove skill?** with *"x" will
  be removed from this computer. A copy is kept in Namzu's backups, so you can put it back.* and
  moves the folder to the backups.
- **Add custom connector** is a dialog: **Name**, **MCP server URL** (https, or http on this
  computer), **Authentication** (**No sign-in**, **Sign in when asked**, or **Header** with a name
  and a value written as an environment reference such as `Bearer ${EXAMPLE_TOKEN}`; a literal
  value is not accepted, so no secret is typed or stored), the notice about trusting developers,
  **Cancel** and **Save**. **Save** stays off until the form is valid, and the reason sits beside it (*Name the connector.*, the address and header rules); once a field has been visited its own problem shows under it. Escape, the backdrop and the X wait while a request runs, as **Cancel** does. It saves through `namzu/mcp/save-user-server`. The server is one of your
  own settings, so its row reads *Remote*, *Your own settings* and a dash; nothing waits for an
  approval. Toasts from this page show over it (the page used to hide the notice area with the
  conversation).
- The two dialogs and the page follow the page's own parts; the end-to-end run
  `e2e/ux-customize-actions.test.mjs` drives them with a test hook (`NAMZU_E2E_SKILL_PICK`, a JSON
  list of paths the file dialog would return, never read by a packaged app).

## Adding, making and removing skills (engine and app plumbing)

The page's Add and Remove actions (above) rest on four host methods in the group `skillsManage`
(`namzu/skills/stage`, `install`, `create`, `remove`, in the table of [Desktop](desktop.md)), all
built on the same modules as [`namzu skills add`, `create` and `remove`](skills-add.md). A method
refuses a Pal, takes exact keys with length caps, and refuses `scope: project` and `tier: project`
for a folder nobody trusted. An older engine lacks the group, so the page hides the entries it
cannot serve: the catalog answer carries `canManage`, which main sets from the engine's `skillsManage` group, so an engine with the catalog but without the group hides them too. Success answers carry `It loads in new conversations.`, because a running
conversation keeps what it loaded.

- **Stage, then install.** `stage` reads and checks what the person chose and returns what each
  item is, what it can run (`grants`), the scripts it ships and whether the name is already in use;
  it writes nothing. The items stay in the host's memory for ten minutes (at most four stages, at most 64 MiB of unpacked files in one stage and 128 MiB across all stages; an item over the stage's total is an item with an error, and the oldest stage goes first when the total is passed), and
  `install` recomputes their digest before it writes, so the app can install only what the person
  was shown.
- **Which paths.** The app's main process opens the file dialog (`.skill`, `.zip`, `.md`) and a
  separate Choose a folder dialog, or takes a drop whose path the preload reads with
  `webUtils.getPathForFile`. It checks each path with `lstat` (a regular file of at most 30 MB, or a
  folder, never a link; at most 20 at once) and remembers it for that window (the last 64). The page can name a
  path only to take back one it was given, and may name it again for as long as the window lives, so adding a second file, removing a card or retrying after a partial failure stages the same paths again; a path it made up is refused before the engine is asked. A \\wsl$ path in a distribution other than the engine's is refused like any other file system.
  The engine checks everything again. An engine on another file system gets a translated path, or
  `This engine cannot read that file. Use a file on the engine's computer.`
- **Connector headers.** The Add custom connector dialog saves through `namzu/mcp/save-user-server`
  with `headers`: names and values that are environment references only (see [Desktop](desktop.md)).
- **Consent follows the file.** The *I trust what it can run* tick is kept only for the same file (name, size, file count and description); choosing a different file of the same name asks again.
