---
'@namzu/sdk': minor
---

Five fixes where a subsystem reported more than it delivered.

**A sandbox tier now says what it actually enforces.** The local provider
reported `id = 'local'` / `name = 'Local Sandbox'` and logged at `info` at
every detected tier, but the tiers are not equivalent: one installs a
deny-default, deny-network profile; one unshares namespaces without
remounting anything, so the child still sees the whole host filesystem; and
one confines nothing at all. A host that deliberately turned isolation
**on** got a tier-dependent amount of it under one undifferentiated name,
and no guard, test or doc anywhere keyed on the weakest tier.

- `isolationOf(environment)` states per-tier what is enforced —
  `filesystem`, `network`, `process` — deliberately pessimistic. The
  namespace tier reports `filesystem: false`, because a private mount table
  is not confinement.
- `sandbox.requireIsolation` (also `new LocalSandboxProvider(log, {…})`)
  **throws** when the host cannot supply a control the caller named.
  Refusing is the point: a control that is accepted and then not applied is
  worse than one never offered, because the caller stops looking. Empty by
  default, so best-effort callers are unaffected.
- Detection now runs the flags it will spawn under instead of checking that
  a binary exists — a host with unprivileged user namespaces disabled
  answers `unshare --version` happily and then fails every spawn. The
  other platform's probe already ran its sandbox for real.
- The namespace tier also unshares the network, which it previously left
  wide open while the other tier denied it unconditionally.
- Constructing at the unconfined tier logs a **warning** naming it as such.

**Compaction stopped measuring the context one turn late.** The provider's
prompt measurement describes the request as it was sent, so the assistant
message and every tool result the turn appended fell outside it — and the
reading was taken verbatim. Separately, the tool catalogue is assembled
apart from the message array and never entered the fallback estimate at
all; a 30-tool registry is easily 10-20k tokens of JSON Schema. Both errors
point the same way, under-count, so the trigger did not jitter around the
threshold — it sat systematically late, worst on the turns that grew the
context the most.

**A remote tool's schema keeps its shape.** `$ref` reached the converter's
permissive branch and became "anything": no type, no shape. Since that node
is inherently optional in Zod, a `$ref`'d field the server listed as
`required` stopped being enforced too — an empty payload validated clean and
was forwarded to the server instead of being rejected with the hint the
executor already builds. `$defs` + `$ref` is the default output of several
common schema generators, so a server that did everything right had its
main argument shown to the model as `{}`. Local pointers are now inlined
first (cycles cut at the repeat, dangling and non-local pointers left
permissive), `allOf` is flattened, and `pattern`, the length and range
bounds, `multipleOf` and the `email`/`uri`/`uuid`/`date-time` formats are
carried onto the converted node — shown to the model *and* enforced. The
conversion is also depth-bounded: a remote schema is untrusted input.

**A declared return shape reaches the model, and a structured result is not
lost.** Servers publish `outputSchema` on a tool listing regardless of
negotiated protocol revision and it had no slot in the type, so the return
shape never reached the model at all. It is now carried verbatim —
shown, never validated — and appended to the description, since no
provider's tool format has a field for it. `ToolDefinition.outputSchema`
takes JSON Schema for the same reason. A server that answers with
`structuredContent` and omits the compatibility text block previously
produced an EMPTY tool result for a call that succeeded, with no diagnostic
anywhere; that payload is now serialized into the output, with the raw pair
available on `result.data`.

**A tool batch killed part-way through is resumed, not repeated.** Results
reach the history only when the whole batch settles, so a hard kill lost
everything that had already come back and the resumed run re-executed those
calls — for a `write_file` that is waste, for a payment or an email it is a
second one. Nothing new had to be recorded: the executor already awaits a
`tool_completed` per tool, inline, and the transcript already persists it.
`RunDiskStore.readCompletedTools()` reads it back and `executeBatch` accepts
those results, so an already-executed call is answered from the record
while the calls that never ran execute for the first time through the
ordinary executor — every guard and permission check still applies. The
discriminator is whether the transcript holds any completion for the turn:
a tool-review park records its checkpoint *before* execution, so it has
none and keeps the existing repair, where re-deciding costs only a round
trip.
