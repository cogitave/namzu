---
'@namzu/project': minor
---

A project can declare delegates, and `deriveSupervisorOptions` turns them into
a `SupervisorAgent` configuration.

`SupervisorAgent` needs an `agentIds` roster and a manager that can spawn them.
Nothing led from a directory to either, so a multi-agent system could be
described on disk and not run.

A directory under `agents/` is read by the same loader that read the root — a
delegate has the same shape as its parent, so this is recursion rather than a
new concept.

```
agent/
├── instructions.md
└── agents/
    ├── researcher/   ← its own agent.ts, instructions.md, tools/
    └── writer/
```

`deriveSupervisorOptions` supplies the roster and leaves the manager to the
host, the same contract `deriveRunOptions` follows: it converts, it does not
run. Delegates come back as plans rather than registered agents, because
registration mutates the host's manager and a function that quietly mutates an
object it was handed for reference is the surprise this package avoids.

A delegate may name its own model and inherits the coordinator's only when it
does not — a cheap model for a narrow job is the common case, and inheriting
unconditionally would bill every specialist at the coordinator's rate.

**One level only.** A delegate may not declare delegates of its own. How deep a
system fans out is a topology decision that belongs to whoever composes it, and
answering it by default is how a directory layout ends up deciding a system's
shape. It also removes the cycle: `agents/a/agents/b/agents/a` cannot be built
if the second level is never read.

A delegate that fails to load is reported in the parent's diagnostics, prefixed
with its path, and is not offered in the roster. A caller reading one list
should not have to walk the tree to find out the run will be short a specialist.
