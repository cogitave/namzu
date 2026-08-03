---
'@namzu/sdk': minor
'@namzu/sandbox': minor
---

The two gaps that were deferred as needing their own design session.

**A question raised inside a tool is now durable, and the answer reaches
the tool that asked.** `ask_user_question` parked through the raw handler
under a synthetic `cp_question_<toolUseId>` id that was never written
anywhere. The checkpoint did not exist: nothing on disk said a human owed
this run an answer, the pending-checkpoint lookup could never return it,
and a remote host could not even *observe* the question except through the
in-process callback. Kill the process while somebody is looking at the card
and the answer could never be applied — the restore path stripped the whole
assistant turn, discarding work that sibling tools in the same batch had
already finished, and re-billed the turn.

The park is now a real checkpoint, with `user_question_asked` /
`user_question_answered` on the event stream, `question.asked` /
`question.answered` on the SSE wire, and an `input-required` A2A status —
the same surfaces a tool-review park has always had.

The re-entry contract was the deferred half, and it turned out to reuse
machinery that already exists. A question checkpoint is written
mid-execution, so it holds the assistant turn with its `tool_use` blocks
unanswered — the same shape a tool-review park leaves. Re-executing that
batch is *how* the asking tool gets re-entered; a carried-answer registry
is what makes the re-entry return the recorded answer instead of parking a
second time; and every sibling that already completed is answered from the
transcript by the crash-resume recovery, so nothing runs twice. An answer
that does not name a call in this turn is refused rather than delivered to
whichever tool now holds that slot.

**The egress policy has a boundary to be enforced at.** Two of its four
shapes were honourable nowhere: the container backend refused a host
allowlist outright because it had nothing to filter through, so `deny-all`
and `allow-all` were the whole spectrum — all or nothing.

`EgressProxy` enforces the other two. Matching has exactly two forms —
exact host, and `.example.com` for a domain and its subdomains — and
substring is deliberately not one of them: `host.includes(entry)` would
admit `example.com.attacker.net`, and plain suffix matching would admit
`notexample.com`. A policy that cannot be read denies, because an allowlist
that fails open is not an allowlist. A request addressed to the proxy
itself is refused rather than forwarded — found by a test that hung instead
of failing, which is exactly the shape that failure takes in production.

`Sandbox.setNetworkPolicy` narrows or widens a **live** sandbox, so "clone
with a token, then drop to deny-all before running untrusted build scripts"
is expressible; it was not, because the policy was frozen at provider
construction. A backend that cannot enforce it throws.

And `brokeredCredentials` settles where the token lives. Any credential the
agent needed to reach an allowed host had to be inside the sandbox, in the
environment, readable by the untrusted code it is meant to be isolated from
— via `/proc/self/environ`, or via a prompt injection that exfiltrates it
over the very egress the policy permits. The real value is now held
host-side and applied at the boundary, scoped per host: a credential
attached to every request is a credential handed to whichever host the
agent was talked into contacting.

One limit, stated rather than hidden: a credential cannot be injected into
a CONNECT tunnel, because reading those bytes would mean terminating TLS
with a CA the sandbox trusts — a strictly larger risk than the one being
mitigated. A workload that needs brokering speaks plain HTTP to the proxy
and lets it upgrade upstream. The allowlist is enforced on CONNECT either
way, since the target names the host in clear text.
