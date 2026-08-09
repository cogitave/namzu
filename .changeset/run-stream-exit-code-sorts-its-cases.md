---
'@namzu/cli': major
---

`run-stream`'s exit code now says whether you can do anything about the failure

**What breaks.** Four conditions that exited `0` now exit `1`, and two flags
that were accepted and ignored are now refused.

| Condition | Was | Is |
| --- | --- | --- |
| `--session <id>` and the conversation cannot be opened | `0` | `1` |
| No LLM provider available | `0` | `1` |
| The session has no provider for an environment reason (no credential, a driver that would not load, a chain that contradicts itself) | `0` | `1` |
| A declared tool server is not available | `0` | `1` |
| A command file that will not parse | `0` | `1` |
| `--continue` / `--resume` | silently ignored, ran stateless, `0` | refused with an `error` event, `0` |

Everything else is unchanged. An unknown option, a missing prompt, a `--cwd`
that does not exist, a bad `--permission-mode`, an interactive command named
headlessly and a provider id that is not a provider all still exit `0`; so does
a run that started and failed; and an untrusted folder still exits `77`.

**If you have a host that treats non-zero as "the folder is untrusted"**, that
is the assumption to change: `77` still means only that, but `1` now means "a
person has to fix something before this can work". If your host retried on `0`,
it will stop looping on faults retrying could never fix — which is the point.

**Why.** The documented rule was *started and failed → 0; refused to start →
non-zero*, and applied to the real cases it did not sort them: an unknown
option, a missing prompt, a bad `--cwd` and an unavailable tool server are all
refusals to start, and all four exited `0` while an untrusted folder exited
`77`. The retry argument the source appealed to does not sort them either —
retrying an unknown option is as pointless as retrying an untrusted folder.

The axis that does: **can the caller reach the run it asked for by changing what
it sends?** Yes → `0`, and the host fixes its own invocation. No → non-zero,
because a person has to act. Dropping `--session` is not "the caller fixing it";
it abandons what was asked for.

`1` rather than a new code because `namzu run` — the same one-shot, differing
only in how it prints — already exits `1` for these conditions and `77` for
trust. `77` stays scoped to trust, because being unambiguous is its whole
justification.

**Two branches had to be split before they could be sorted.** `hasProvider ===
false` covered both a provider id that is not a provider (yours to fix) and four
environment failures; a refused command expansion covered both a bad invocation
and a command file that will not parse. Each now carries the distinction as a
field — `AgentSession.errorKind` and the `fixable` flag on a `refused`
expansion — rather than leaving a caller to match on the message text, after
which the message could never be reworded.
