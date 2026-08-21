---
'@namzu/sdk': major
'@namzu/cli': major
---

Require every `PluginLifecycleManager` host to provide project and user
`scopeRoots`. Plugin installation now canonicalizes a candidate against that
declared filesystem authority, refuses symlinked or non-regular plugin
manifests, and keeps executable admission and lifecycle ownership private to
the manager instead of trusting mutable `PluginRegistry` records.

Hosts constructing the SDK manager must pass
`scopeRoots: { project: trustedWorkingDirectory, user: userHomeDirectory }`.
Move plugins under the matching root instead of relying on a symlink or an
out-of-scope registry record. The CLI applies those roots automatically and no
longer loads project or user plugins through links that leave the admitted
scope.
