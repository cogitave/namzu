---
type: Reference
title: Project and session state
description: How the CLI maps working directories to durable projects and initializes installation and conversation identities.
resource: packages/cli/src/integrations/sessions/store.ts
tags: [cli, ids, storage, memory]
status: stable
---

# Project and session state

The working directory is where tools execute. The Project groups durable
conversations and searchable memory. A Session identifies one conversation; a
Run identifies one execution within it. Changing the working directory does
not require a new Project when both directories belong to the same checkout.

## Selecting a Project

The CLI canonicalizes the working directory, resolving symlinks, then:

1. Reuses an existing central binding for that exact directory under the
   installation's tenant. This preserves histories created by earlier versions.
2. Otherwise reuses or creates the binding for the nearest directory containing
   `.git`. A `.git` file is also a boundary, so Git worktrees remain separate.
3. Outside a repository, binds the working directory itself.

Opening a new checkout from its root or `packages/cli` now selects the same
Project and Topic. A new Project's display name is its root directory's name.
Its generated ID remains the stable storage key. The existing SDK root-path
binding resolves the path to that key; no additional CLI project registry is
maintained. `namzu state` uses the same central selector as session startup.
Its filesystem inventory still covers the working directory's `.namzu` and
the application home; run it at the checkout root to count root-level authored
memory as well.

Tool execution, project trust and configuration continue to use the selected
working directory. Nested repositories and worktrees have distinct roots.
Unrelated scratch directories are separate Projects: their common `/tmp`
parent does not establish shared ownership.

## Identity and persistence

Generated state lives under `~/.namzu`, or `NAMZU_HOME` when configured:

- `identity.json` holds the installation's tenant identity.
- `projects/<projectId>/project.json` records the Project and its root path.
- `projects/<projectId>/cli/topic.json` holds the Project's CLI Topic.
- Conversations live in the Project's sessions directory; CLI sidecars such as
  titles and desktop session mappings live in its `cli` directory.

The installation identity and Topic are initialized once. Concurrent first
launches publish one complete file and all use the winner. Existing malformed
files cause an error; startup does not replace them with a new identity.

ID prefixes remain part of the SDK's persisted format. Callers should use the
SDK's constructors and treat each ID as an opaque key. A prefix is neither a
project-root detector nor proof of ownership; tenant and Project membership
are checked by the stores.

## Existing state

Previously every exact working directory received its own central Project.
Those bindings keep their IDs, Topics and conversations. New subdirectories
without a binding share the checkout-root Project. Existing projects are not
automatically merged, and existing records are not renamed.

The current CLI reads central state under the installation tenant. A historical
global `cli.json` or project-local runtime store is not an active selector.
In particular, a legacy Project without `rootPath` cannot safely be assigned
to the current checkout from that pointer alone. `namzu state` inventories
legacy files but does not import or repair them.

Curated memory follows the checkout root for new files, with existing
directory-local memory taking precedence. See [Memory](memory.md).
