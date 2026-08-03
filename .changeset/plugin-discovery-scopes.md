---
'@namzu/sdk': minor
---

`allowedScopes` is a trust boundary now instead of a comment.

`discoverAllPluginDirs` scans two locations — `.namzu/plugins` under the working directory, and the same path under the user's home directory — and they are not equally trusted. A project plugin is reviewable in the repository the agent is working on; a user plugin comes from a home directory the repository's reviewers never see, and a plugin is arbitrary code with hooks into tool execution.

`PluginRuntimeConfig` has carried `enabled`, `autoDiscovery` and `allowedScopes` for as long as it has existed. Nothing anywhere read any of the three, and discovery scanned both locations unconditionally, so a host who set `allowedScopes: ['project']` got user plugins anyway — from a setting that reads exactly like a boundary.

`discoverAllPluginDirs(cwd, { enabled: true, allowedScopes: ['project'] })` now honours it. A disallowed scope is **not scanned** rather than scanned and filtered: reading a directory you have been told not to look in is pointless work, and the returned count would disclose how many plugins live there. `enabled: false` or `autoDiscovery: false` discovers nothing at all, and a parsed `PluginRuntimeConfig` satisfies the options type as-is.

Calling it with no second argument scans both scopes, exactly as before — every existing caller is unaffected, and a caller who opts in gets what the config says.
