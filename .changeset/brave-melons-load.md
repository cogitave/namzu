---
'@namzu/project': minor
'@namzu/sdk': minor
---

Adds `@namzu/project` — a conventional agent directory, read into typed,
inspectable definitions.

```
my-agent/agent/
├── agent.ts          # optional — model, temperature, budgets
├── instructions.md   # optional — the system prompt
├── tools/search.ts   # default-exports defineTool(…)
└── skills/plan-a-trip/SKILL.md
```

```ts
const { manifest, ok, diagnostics } = await loadProject('./agent')
await runAgent(deriveRunOptions(manifest, { provider, prompt: 'go' }))
```

A **loader, not a runner**, and not in `@namzu/sdk`: the kernel does not
mandate a directory layout any more than a kernel mandates `/etc/foo.conf`.
`deriveRunOptions` returns ordinary `RunAgentOptions`, so there is no second
code path and no behaviour reachable only through the convention.

**Importing a directory runs it.** `loadProject` imports every module-backed
file, in this process, with this process's privileges — a top-level side effect
in `tools/search.ts` happens during the load. There is no in-process boundary
that would change that, and `@namzu/sandbox` confines tool execution rather
than module import. For a directory whose author you are not,
`modules: 'skip'` imports nothing while still returning the full structural
truth: every path, the instructions, the skills, duplicate detection. That is
also the mode a CI gate and a UI file tree want.

**TypeScript without a build step.** Files load through `await import()`, so
`.ts` is handled by Node's own type stripping. Stripping erases types rather
than transforming code, so `enum`, decorators, parameter properties, runtime
`namespace`, extensionless relative imports and tsconfig `paths` aliases do not
work — the README tables each one against what to write instead, and the errors
name the remedy. A host that needs them passes `importModule` and hands in
`jiti` or a `tsx`-registered importer: three lines in the host, no bundler in
this dependency tree.

**Nothing fails silently.** A file that cannot load is reported with its path
and reason, never dropped. Two behaviours worth knowing: a symlink is refused
rather than followed, because the file that would be imported is not the file
that was listed; and a timed-out import is `'abandoned'`, not `'failed'`, since
`import()` cannot be cancelled — the module may still finish, and Node caches
it, so a later load in the same process can see the same file succeed.

`channels/` and `schedules/` are **not** in this version. A trigger of
`{ id, handler }` cannot express a signed webhook — verification needs the raw
body, and a handler receiving a parsed one can never check an HMAC — carries no
idempotency key while webhooks retry and schedules double-fire, and a cron
field with no timezone story is a declaration nothing drives. Each would be a
breaking change to a published type; the shape question gets its own pass.

`@namzu/sdk` additionally exports `resolveWithin`, `resolveWithinReal` and
`isWithin`, the containment helpers its own filesystem tools use. They were
internal while three call sites outside that file needed them.
