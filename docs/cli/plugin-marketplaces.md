---
type: Reference
title: Marketplaces and downloads
description: Adding a marketplace from a repository or an https address, refreshing it, how an address is read, how Git and downloads are run safely, the sources a catalog entry may name, pins, sparse checkouts, the block list and the update that shows what changed in what runs.
resource: packages/cli/src/integrations/plugins/fetch/index.ts
tags: [cli, plugins, marketplace, git, download, security, pins]
---

# Marketplaces and downloads

A marketplace is a catalog of plugins. [Install plugins](plugin-install.md)
covers the install itself and the marketplaces that are a folder or a `.json`
file on this computer. This page covers the ones that are downloaded: a Git
repository or a hosted `marketplace.json`, and the plugins their catalogs
point at.

```
namzu plugin marketplace add <owner/repo | https://… | git@host:path | folder | file.json>
                             [--ref <ref>] [--sparse <path>...] [--scope user|project|local]
                             [--dry-run] [--yes] [--cwd <dir>] [--json]
namzu plugin marketplace update [<name>] [--json]
namzu plugin update <id> [--yes | --accept-surface <sha256>] [--json]
```

Nothing is downloaded until you have said yes, nothing downloaded is run, and
nothing runs in the background: the commands above are the only things that
fetch.

## How an address is read

`marketplace add` reads what you typed in a fixed order, without touching the
disk or the network:

1. `user@host:path[.git][#ref]`, the form `scp` and Git use for ssh: a Git
   repository.
2. `https://…`. An address ending `.git`, or containing `/_git/`, is a Git
   repository. `https://github.com/owner/repo` is GitHub's. On gitlab.com and
   bitbucket.org an `owner/repo` path is rewritten to the clone address. Any
   other https address is a hosted `marketplace.json`. `#ref` after a repository
   address names a branch, tag or commit.
3. `./`, `../`, `/`, `~` or `C:\`: a folder or a `.json` file on this computer
   (see [Install plugins](plugin-install.md)).
4. `owner/repo`, with `#ref` or `@ref`: GitHub.

Anything else exits 64 with `Not a marketplace address. Use owner/repo, an
https:// address, or a folder path.` These are refused before anything else
happens: `http://` and `file://` addresses, an address with a user name,
password or query (`Remove the sign-in details from the address; Namzu uses
your own Git setup.`), a page inside a GitHub repository (`/tree/…`, `/blob/…`),
a hosted `marketplace.json` with a `#ref` (it is one file, not a repository),
and a network share. A value that starts with `-` is never an address, and a
ref or a path that Git could take for an option is refused.

`--ref` sets or replaces the ref of a Git source; `--sparse` (one or more
folders, up to the next option) checks out only those folders and the folder of
the catalog itself, so a large repository costs a part of its size. Both are for
a repository and are exit 64 for a folder, a file or a hosted catalog. Write
the address first: every word after `--sparse` up to the next option is a
folder.

## Adding, and what you are asked

1. **The block list.** `plugins.blockedMarketplaces` is checked before anything
   is fetched. A match exits 77 with `Adding this marketplace is turned off in
   your settings.` See [The block list](#the-block-list).
2. `--dry-run` stops here: it prints the normalised source and the notice and
   does no I/O.
3. With no terminal and no `--yes` the command exits 75 with `A marketplace can
   run code. Add --yes to confirm that you trust <source>.` and has fetched
   nothing.
4. The repository or catalog is fetched into `plugins/.staging/` and read. A
   repository without the catalog is exit 65, `… is not a marketplace`; a
   name that breaks the rules (see [Install plugins](plugin-install.md#marketplaces))
   is exit 65 too.
5. **The consent.** You see what you are adding, from what was fetched:

```
Add marketplace "team-tools" from github.com/acme/team-tools?

Plugins from a marketplace can run programs on this computer, with access to
your files. Namzu does not control this marketplace or its plugins, and its
owner can change them later. Add only marketplaces you trust.

  Owner:    Acme Tools
  Plugins:  14 (3 cannot be installed here)
  Commit:   4f1c0a2  (main)

You will see what a plugin does before you install it.
Add this marketplace? [y/N]
```

   `--yes` accepts it (the text goes to standard error). A no is exit 1 and
   leaves nothing behind. The second consent, for each plugin, is the install
   preview.
6. The same name from the same source exits 0, `already added; nothing
   changed.` (and declares it at this scope if it was not). The same name from
   another source is exit 65.
7. The fetched folder moves to `$NAMZU_HOME/plugins/marketplaces/<name>/` (a
   clone keeps its `.git`; a hosted catalog is saved where the common plugin layout keeps its catalog), `known_marketplaces.json` gets the source,
   the commit, the time and the consent, and the scope's `extraKnownMarketplaces`
   gets an entry. Auto-update is off.

The result says how many Git LFS files the repository holds (their content is
not downloaded; they stay small pointer files) and how many submodules it lists
(none is downloaded). `--json` has `commit`, `lfsPointers` and `submodules`.

A marketplace you downloaded is Namzu's copy, and `marketplace remove` removes
it; a folder you pointed at is never touched.

## Updating

`marketplace update [<name>]` refreshes the catalog of one marketplace or of
all. It never installs or updates a plugin.

| Source | What it does |
|---|---|
| Repository | Fetches a fresh shallow copy aside and swaps it for the old one, so a copy edited in place cannot interfere. The old copy goes to the trash folder that `plugin prune` empties. Prints `updated 4f1c0a2 to 77be9d1 (3 new, 1 changed)`. |
| Repository pinned at a commit (`#<40 or 64 hex>`) | Does nothing: `pinned at 4f1c0a2`. A refresh never moves it. |
| Hosted catalog | Fetches it again and says what is new and changed, or `already up to date`. |
| Folder or file | Reads it again: `re-read (14 plugins)`. |

After each marketplace it names the installed plugins whose catalog entry now
has another version, with the command that updates them. One failure does not
stop the rest: the exit is 69 at the end, and each failure is named. A
marketplace that now calls itself by another name is not updated. A copy whose
folder is not under `plugins/marketplaces/` is never replaced.

`--json` has `results`, one row per marketplace: `name`, `outcome` (`updated`,
`up-to-date`, `pinned`, `re-read`, `failed`), `message`, `from`, `to`,
`newPlugins`, `changedPlugins` and `newer`.

## Where a plugin comes from

A catalog entry's `source` is one of these. Each download goes through the same
module as a marketplace, with the same limits.

| `source` | Meaning |
|---|---|
| `"./plugins/ledger"` | A folder in the marketplace. The plugin is copied from Namzu's copy of the marketplace, and the install records the marketplace commit. A hosted catalog has no folders: such an entry is marked not installable. |
| `{ "source": "github", "repo": "owner/repo", "ref"?, "sha"? }` | A repository. |
| `{ "source": "url", "url": "https://…/x.git", "ref"?, "sha"? }` | A Git address (https, ssh or the `user@host:path` form). |
| `{ "source": "git-subdir", "url", "path", "ref"?, "sha"? }` | A folder of a larger repository. Only that folder (and the files at the top) is checked out. A `path` that leaves the repository or names no folder is refused. |
| `{ "source": "archive", "url": "https://…/x.zip", "sha256"? }` | A zip over https. The plugin may be at its top or one folder down. |
| `npm`, `command`, and any entry with `headers` or `headersHelper` | Not installable here. They would run a package manager or another program to get the code. The entry is listed with the reason, and `install` exits 69. |

A **pin** holds a plugin at a commit. `sha` (40 or 64 hex) is fetched by its id,
not by following a branch, and the checkout must be at it or the install stops
with exit 65; a `sha` that does not exist on the host is exit 66. Without a
pin the entry follows its `ref`, or the default branch. `sha256` on an archive
is checked against what arrived and a mismatch exits 65 before anything is
unpacked; with none, the preview says `This download is not pinned to a digest.`
and the digest covers it. A marketplace is pinned by a commit id as its ref (see
Updating).

A plugin copy is made from the fetched files without `.git`. The install preview
adds a note when the repository holds Git LFS files or submodules, and its
headline names the commit: `Install ledger 1.2.0 from team-tools (commit
9ab3c1d)?`. The commit is recorded as `gitCommitSha` in the install record.

## Updating a plugin

`namzu plugin update <id>` reads the plugin again from where its catalog entry
points (it does not refresh the catalog; run `marketplace update` first) and
compares what would now run with what you accepted. If the version is the same
and so is everything that runs, it says `up to date`. If only a version
changed, or only files that cannot run changed, it applies after printing the
summary. If anything that runs changed (a hook, a server, a script, a
pre-approved tool, a file with a program extension or an execute bit), the new
preview comes back with the change marked, and you are asked again. `--yes`
accepts what is displayed, `--accept-surface <sha256>` only the surface with
that digest, and with neither and no terminal the command exits 75 having
changed nothing. A declined update removes the staged copy. The old version stays,
marked, for a conversation that has it open; `plugin prune` takes it a day later.
A pinned plugin is updated by changing its `sha` in the catalog and refreshing
the marketplace.

## How a fetch is made safe

One module, `integrations/plugins/fetch/`, makes every download.

**Git** is the system `git`, started with an argument list and never a shell.
Its environment is the one you have, with every `GIT_*` variable removed, and
then: `GIT_TERMINAL_PROMPT=0` and an empty `GIT_ASKPASS`, so a credential prompt
cannot appear (your own Git setup, a credential helper or an ssh key, still
works); `GIT_SSH_COMMAND` in batch mode with host keys checked;
`GIT_ALLOW_PROTOCOL=https:ssh`; and `GIT_LFS_SKIP_SMUDGE=1`. The command line adds
`core.hooksPath` pointed at the null device, `core.fsmonitor=false`,
`core.symlinks=false` (a link in the repository arrives as a plain file holding
its target), `protocol.ext.allow=never`, `protocol.file.allow=never` and
`transfer.fsckObjects=true`, so an object that fails Git's integrity checks
(including a `.gitmodules` that names a command to run) is refused. A clone is
`--depth 1 --no-tags --single-branch --no-recurse-submodules`, with `--branch`
for a branch or tag, a fetch by id for a commit, and a blob-less partial clone
with a sparse checkout for `--sparse` and `git-subdir`. The address is always
after `--`.

Only https and ssh addresses are accepted. A run is stopped after 120 seconds
(`NAMZU_PLUGIN_GIT_TIMEOUT_MS` changes it, at most 600 000) by killing its whole
process group, or its process tree on Windows, and its output is kept to 1 MiB.

**https** downloads (a hosted catalog, an archive) send a plain request with no
cookies or sign-in; follow at most five redirects, none to an address that is
not https; stop at 10 MiB for a catalog (30 seconds) and 200 MiB for an archive
(120 seconds); and take a catalog only if it is JSON or plain text. An archive
goes through the shared zip reader with the plugin limits (5 000 entries, 256 MiB
unpacked, a ratio of 100, no path that climbs out).

Everything before your yes is written only under `plugins/.staging/`, and what
is fetched is never run. A plugin is copied from a clone with its own limits
(20 000 files, 256 MiB, links and special files skipped, modes normalised).

### Errors, in words

| You see | Exit | Meaning |
|---|---|---|
| `Git is needed for this address. Install Git and run the command again.` | 69 | There is no `git` program. |
| `Repository not found or not accessible…` | 66 | The address does not exist, or your own Git setup may not read it. Namzu cannot ask for a password. |
| `Could not reach <host>.` | 69 | The network or the name did not answer. |
| `Git took longer than N seconds and was stopped…` | 69 | The timeout. |
| `That branch, tag or commit does not exist in the repository.` | 66 | The ref. |
| `The repository failed Git’s integrity checks…` | 65 | `fsckObjects` refused it. |
| `The download does not match the digest…` | 65 | An archive's `sha256`. |
| `… is not a marketplace` | 65 | No catalog where one belongs. |

## The block list

`plugins.blockedMarketplaces` lists addresses that `marketplace add`,
`marketplace update` and every download from a marketplace refuse (exit 77). An
entry is `owner/repo`, `owner/*` (GitHub), `host/path`, `host/*` or a bare host
(`example.com`); it is compared with the marketplace's normalised address
(lowercase, no scheme, no `.git`). It also applies to the address of a plugin
entry, so a blocked repository cannot be reached through an allowed marketplace.
A folder or a file on this computer is never blocked. The key is read from your
user config and the managed file only: a project or local file that carries it is
ignored. The lists of the user and managed layers are joined: a layer can add
to what is blocked and none can remove an entry another layer set.

```yaml
plugins:
  blockedMarketplaces:
    - acme/*
    - example.com
```

## Tests

The fetch tests never use the network. Git runs against a bare repository in a
scratch folder through the `allowFileProtocol` option (a parameter that only
tests pass); https is a server bound to `127.0.0.1` through `allowLoopbackHttp`,
which only tests pass; an address is rewritten to either with `rewriteUrl`, and
one that is not mapped goes nowhere. Timeouts are driven by fake timers and an
injected process runner.
