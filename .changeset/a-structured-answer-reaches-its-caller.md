---
'@namzu/sdk': major
---

**A delegated agent's structured output now reaches its caller.** A supervisor
that fanned out to five schema-configured specialists received five *strings* —
the model had to re-parse prose it had just caused to be serialized, and the
host got no typed handle on any child's answer.

Nothing was missing from the runtime. `Run.structuredOutput` has carried the
parsed, validated value throughout, and the eval harness reads it correctly;
every ergonomic boundary above it dropped the value three lines from its
caller. This connects them:

- **`BaseAgentResult.structuredOutput`** — archetype results carry the value,
  so `ReactiveAgent.run()` no longer returns `result?: string` and nothing else.
- **`runAgent` can ask for a schema.** It never forwarded the config, so the
  most convenient way into the kernel was the one way that could not produce a
  typed answer. The validated value comes back on `RunAgentResult.structuredOutput`.
- **Both delegation surfaces return the object.** `Agent` and `create_task`
  each prefer the child's structured answer over its prose. Both, because the
  last time a rule lived at one delegation site only, `create_task` shipped
  without the success check `Agent` already had.
- **It survives a reload.** `run.json` now persists `structuredOutput`, so a run
  fetched by id still has the thing it was run for.

**What is major: `run.result` now holds the serialized structured value.**
Previously the structured exit deliberately did not set it, and result
resolution walks back from the message tail and stops at the first
non-assistant message — so a structured run, whose last assistant turn is a tool
call rather than prose, kept whatever text an *earlier* turn happened to
produce. A host reading `run.result` got a sentence from the middle of the run
presented as its answer.

The other two options are worse. Leaving it is a stale value read as a fact,
which is the defect. Clearing it makes a run that plainly answered report no
answer, so a host testing `if (run.result)` concludes nothing was produced.
Serializing is also what every text-shaped consumer needed anyway — the
transcript, `Run.result`, and both delegation tools handing a child's answer to
a parent model — and doing it once, where the value is known, replaces three
slightly different serializations.

**If you relied on the old behaviour**, read `run.messages` for the model's last
prose; `run.result` on a structured run is now `JSON.stringify(structuredOutput)`.
Runs without a schema are unchanged.
