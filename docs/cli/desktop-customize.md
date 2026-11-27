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

There is no Yours/Discover switch on Skills. Namzu has no catalogue of skills to discover, so the
switch would have one side. On **Plugins** it appears beside the tabs once a marketplace has been
added (see [Marketplaces and plugins: the page](#marketplaces-and-plugins-the-page)).

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
names). With no plugin, the page says where they live (`.namzu/plugins/`, `~/.namzu/plugins/`).
Where the engine offers the group `pluginsManage`, the tab also adds, updates and removes plugins
and marketplaces, below.

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

## Marketplaces and plugins (engine and app plumbing)

The page's plugin actions rest on fourteen host methods in the group `pluginsManage` (the
`namzu/marketplaces/*`, `namzu/plugins/*` and `namzu/ops/cancel` rows of [Desktop](desktop.md)),
built on the modules behind [`namzu plugin install`](plugin-install.md) (`parseMarketplaceAddress`,
`readCatalog`, `resolveEntrySource`, `planInstall`, `commitInstall`, `commitUpdate`,
`removeInstall`, and the recorded yes in the settings files). A source form the engine learns to
fetch later (a Git repository, an address) is therefore available to the app as soon as those
functions take it. Every method refuses a Pal (`Host plugins are not inherited by Pals.`), takes
exact keys with length caps, and refuses `project` and `local` places for a folder nobody trusted.
An older engine lacks the group, so main reports `supportsPluginsManage()` false and the page hides
what it cannot serve.

- **Show, then yes.** `plan` copies the plugin into the engine's staging folder and answers with the
  consent surface and its digest; `install` takes that digest back, recomputes it from the staged
  files and refuses any other, so the app can install only what the person was shown. Stages and
  plans live in the host process (at most four each, ten minutes; a dropped or expired one has its
  copy removed). What a crash leaves behind is what `namzu plugin prune` removes.
- **An update asks only when something that runs changed.** `update` compares the new source with
  what the person accepted (the same comparison the command uses) and answers `needs-consent` with
  the digest and the changes; nothing is written until `acceptDigest` equals it.
- **Long steps.** A call may carry an `opId` the app chose. Progress arrives as the notification
  `namzu/ops/progress`, which main forwards as the event `op-progress`; `namzu/ops/cancel` stops the
  step at its next check, before it writes anything. A write that has started is not interrupted.
  Each project has its own host, so `cancelOp(opId, projectId)` goes to the host the step ran on.
  The page names every read with a fresh `opId` and cancels the one before it when the place
  changes, on Cancel and when the page closes.
- **The consent surface is never cut.** The view of `plan` and `update` carries every hook command,
  server command, argument, address and variable name whole. A plugin with a runnable string over
  2000 characters or more than 100 rows in a list is refused (`This plugin runs more than can be
  shown in full here, so it was not read. Install it from the command line, which lists
  everything.`); the page reads strings up to 2000 characters without a cut.
- **Removing a marketplace** removes the plugins you installed from it for yourself and for this
  folder. If one is installed for another folder, the call is refused before anything is written and
  names it; remove it from that folder first.
- **Which paths.** Main opens a plugin file dialog (`.zip` or `.plugin`) and a folder dialog, or takes
  a drop, through the same path registry as skills. A file passes only when `lstat` says it is a
  regular file of at most 200 MB whose first bytes are a zip signature; a link, another extension or
  a larger file is refused with a sentence. Only a path registered by one of those gestures in the
  same window is forwarded, one at a time, and on the WSL engine it is translated as skill paths are
  (`This engine cannot read that file. Use a file on the engine's computer.` when it cannot be).
- **A listing with no conversation open.** With no conversation, `namzu/plugins/list` read only the
  plugin folders, so a plugin installed from a marketplace or an upload was missing from the page
  that installed it. The host now adds a row for every installed plugin (an install record that
  applies to this folder or to the person) the listing did not name: name, version, description,
  `scope`, `status` `installed` (`disabled` when the saved record says off and a conversation is
  open), `startupEnabled` from the saved record, and the manifest's skills and servers, all read
  from the install copy without running anything. A line saying plugins are off for the project is
  dropped once an install has turned loading on, because the listing was read before that.

## Marketplaces and plugins: the page

Where the engine has the group `pluginsManage` (one that does not answers `marketplaces` with
nothing, and the page then shows the old Plugins tab and **Create with Namzu** only):

- **Add** on Plugins holds **Add marketplace**, **Upload plugin** and **Create with Namzu**.
  *Create with Namzu* opens a new conversation with *Help me create a new Namzu plugin. Ask me what
  it should do, put it in a new folder, check it with namzu plugin validate, and tell me how to try
  it with --plugin-dir.* in the box, unsent; the model writes files with its own tools and
  approvals and nothing is installed.
- **Add marketplace** is a dialog: the notice (*Only add marketplaces you trust. Namzu does not
  control their plugins, and their owners can change them later.*), **URL** (placeholder `owner/repo
  or a Git address`) with the help line and **Choose a folder**. While the person types, the page asks
  `namzu/marketplaces/preview` (the address is parsed, nothing is fetched) and shows `Will add
  <address>` or the engine's refusal in its words; **Add** stays off until the address is accepted.
  **Add** is the consent: it calls `namzu/marketplaces/add` for the *Yours* place with `accepted:
  marketplace-v1`, shows the phase the engine announces (`Checking…`, `Downloading…`, `Reading…`) and
  **Cancel** stops the step through `namzu/ops/cancel`. A Git or URL address is added exactly as far
  as the engine's own marketplace functions go; the dialog does not decide. A toast says
  `Marketplace "team-tools" added (14 plugins).` and the page switches to **Discover**.
  *Keep up to date automatically* is not offered: the host method has no such option yet.
- **Yours | Discover** appears beside the tabs once a marketplace exists. **Yours** is the installed
  plugins, grouped by where each came from (**From team-tools**, **Uploaded**, and **Installed** for
  a plugin placed by hand), then a small **Marketplaces** list (letter tile, name, `N installed`,
  `N plugins · source · updated …`, menu **Update now** and **Remove**). **Discover** is a card grid
  read from `namzu/marketplaces/available`: letter tile, name, two lines of description, `from
  team-tools · 1.0.0` and a **+** named `Add <name>`; a plugin that is already installed shows a
  check instead, and one that cannot be installed here shows the reason as the **+**'s tooltip. The
  search field filters both views.
- **The consent card** is what the **+** opens, and what **Upload plugin** shows after reading the
  file: **Install for** (**Yours** or **This project**; the second is off, with the reason, in a
  folder nobody trusted), the plugin's name and version, **This plugin adds** (skills, commands,
  agents, tools it may use), **Runs on this computer** (what the command-line preview lists, at full
  strength and with each command whole in monospace: each hook with its type, its event in words
  (*Before a tool runs (Bash)*) and command, each local server with its command, the names of the
  variables it would get and *needs setup*, each remote server with its address and what it would
  send, each module with whether it is isolated and what it declares, each script with its size and
  *executable*, an unpinned download), **Left out** (what the reader refused), **Not used by
  Namzu** (muted), the digest in small print, *Plugins run code on your computer, with access to your
  files. Install only what you trust.* and, when plugin loading is off, an unticked *Turn on plugin
  loading (needed for plugins to run)*. **Install** is the consent: it sends the digest of what was
  on screen to `namzu/plugins/install`, which refuses any other. A plugin already installed shows
  `"x" is already installed (version 1.0.0).` and **Install** stays off (use *Check for updates*).
- **Upload plugin** is a page (**← Your plugins**, *Upload a plugin*): a notice, the drop zone
  (*Drag and drop a plugin file here, or browse.*), **Choose a folder**, the help about the manifest,
  **Install** (off until a file is read, with *Choose a file to continue.*) and **Cancel**. One
  plugin at a time. The file goes through `plugins/stage` (read aside, nothing installed) and then the
  consent card above.
- **A plugin's menu** (row and detail): **Turn off** or **Turn on** (for a plugin Namzu installed
  this writes the saved record through `namzu/plugins/enable` and works with no conversation open;
  an open, idle conversation follows through `set_enabled`; **Turn off** first asks `Turn off
  "ledger"?`), **Check for updates**, **Update** (when a check found a newer version), **Details**,
  and **Remove** (red). A plugin placed by hand keeps the old switch, has **Check for updates**
  disabled with the reason, no **Remove**, and its detail says `This plugin is a folder you placed in
  .namzu/plugins. Namzu will not delete it; remove the folder yourself.` A plugin you uploaded has
  no source to compare with, so its check is disabled with that reason.
- **Check for updates** shows `Checking for updates`, then `Up to date`, `Version 1.3.0 is available`
  or `Couldn't check for updates. Try again.` beside the row. **Update** calls `namzu/plugins/update`;
  when what runs changed it answers `needs-consent`, and the page shows the consent card headed
  **What changed** with **Update** as the yes (sending `acceptDigest`); otherwise it applies and
  says `Updated … It loads in new conversations.`
- **Remove plugin?** (*"ledger" will be removed from this computer. You can add it again from its
  marketplace.*) has **Also delete its saved data**, off. **Remove marketplace?** says how many
  installed plugins go with it and names them; their data is kept. Nothing leaves the page for the
  network except what the person asked for.
- `e2e/ux-customize-plugins.test.mjs` drives all of it against a marketplace folder built on disk
  (add it, Discover, install through the consent card, Yours, a version bump and the update, turn
  off, remove, an uploaded zip, remove the marketplace, Create with Namzu). The test hook
  `NAMZU_E2E_PLUGIN_PICK` (a JSON list of paths the plugin file dialog would return) is never read
  by a packaged app.
