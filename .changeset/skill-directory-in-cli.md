---
"@namzu/cli": patch
---

A skill the model loads now names the directory its files are in (#536), so a skill whose instructions say `scripts/…` or `references/…` can be followed. On the host it is the directory the skill was read from. With `sandbox.enabled`, a skill under the working directory or an added directory gets the same path, which the sandbox mounts; every other skill (the user and shared-user tiers, the built-ins, `.agents/skills` above the working directory, user plugins, and every skill under an `ephemeral` workspace) is reported as not reachable instead of being given a host path the sandbox refuses. Nothing to do on upgrade.
