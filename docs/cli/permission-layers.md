---
type: Reference
title: Permission layers and remembered answers
description: How the permissions tables of the user file, the project file, the project's local file, a selected profile and the managed file combine (a deny from any layer wins), where a "don't ask again" answer is written, and which shell commands run without a prompt.
resource: packages/cli/src/permissions/rules.ts
tags: [cli, permissions, config, layers]
status: stable
generated: { by: process:claude-code, at: 2026-10-19T00:00:00Z }
---

# Permission layers and remembered answers

The `permissions` table is read from every config file that has one, and the tables are **joined**, not replaced. The order is the reference terminal's: user, project, local, profile, managed, lowest to highest.

## How the layers combine

Each layer decides a call on its own, by the rules it always had: the most specific pattern first, and a narrower allow in a table beats a broader deny of the same table. The layers are then combined:

1. if any layer denies the call, it is denied;
2. else if any layer asks, it is asked about;
3. else if any layer allows it, it runs;
4. else no layer named it and the mode decides.

Which layer is higher does not change the outcome. A project table cannot erase a user's deny, and a managed table adds to the rules below it. `permissions` on the loaded config is the combined view (the stricter effect where two layers name the same pattern); `permissionLayers` is the list the decision is made from. `permissionLayers` is the loader's own field: a file that writes it is refused.

Before this, a layer that wrote a `permissions` table replaced the whole table of every layer below it, key by key.

## Upgrading

If you relied on a project or managed table replacing a user's rules, move the rule you wanted gone out of the lower file; there is no way for a higher layer to switch a lower layer's deny off, by design. A rule that used to be hidden by a higher layer's table now applies again, which can ask about or refuse calls that used to run.
