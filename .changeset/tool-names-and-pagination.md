---
'@namzu/sdk': major
'@namzu/cli': patch
---

Tool names are validated, and a paged remote catalogue is read to the end.

**Every plugin-contributed tool name was illegal.** A tool name reaches the
provider verbatim and the major message APIs accept `[a-zA-Z0-9_-]` up to 64
characters — but the plugin namespace separator was `:`, so every tool a
plugin contributed carried a name the wire rejects. Nothing checked: names
are derived by concatenation at three separate construction sites and none
validated the result.

The rejection is a 400 on the **whole request**, not on that tool. Those
tools are registered deferred, so it fired the moment something activated
one, with nothing naming the culprit.

- `assertToolName` runs at registration, where a bad name can still be
  attributed and costs the run nothing.
- **Breaking:** `PLUGIN_NAMESPACE_SEPARATOR` is now `__`, which renames every
  plugin-contributed tool id — `fs-plugin:mcp__fs__read_file` becomes
  `fs-plugin__mcp__fs__read_file`. A host that names one of these in an
  allowlist, a permission rule or a preserve-list must update it. The two
  changes have to land together: adding the check without the rename would
  refuse every plugin tool.

One driver had already ratified passing names through untouched, on the
grounds that a confusing name is "a naming problem to fix in the registry,
not something to paper over" — which is precisely why the registry has to be
the one that checks.

**A paged remote catalogue is now read to the end.** `tools/list`,
`resources/list` and `resources/templates/list` each sent an empty params
object and returned the first page — never sending a cursor, never reading
the one that came back. A server that pages its catalogue contributed only
its first page: the rest were never registered, never namespaced, never
advertised, with no error and no warning. Drift detection did not help
either, since it compared page one against page one.

The symptom is a model that never uses a tool it was told about, which reads
as model incompetence rather than a client bug. Both clients — the SDK's and
the CLI's — now thread the cursor. A server whose cursor never ends is
refused after 100 pages rather than looping forever or stopping silently,
since stopping silently is the failure being fixed.
