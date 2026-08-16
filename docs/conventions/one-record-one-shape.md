---
uid: namzu.conventions.one-record-one-shape
title: One log record has one shape, and rules 3 and 4 prove it against the type, not the name
description: Every diagnostic goes through an injected Logger with a constant message body and namespaced attribute keys. Two of the six rules the gate enforces resolve this against the real Logger and LogAttributes types, not a name match — and cannot see where an attribute value came from.
type: Convention
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-16T00:00:00Z
lastReviewed: 2026-08-16
tags: [convention, logging, observability]
---

# One log record has one shape

Ratified 2026-08-16 (rules 3 and 4; the seed rules below landed earlier in
the same session).

Every diagnostic in this codebase is emitted through a `Logger` the caller
was given — never read from module scope, never written to a stream
directly — with a **constant message body** and **namespaced attribute
keys**. That is the whole rule. What follows is what `scripts/check-log-
standard.mjs` currently enforces of it, and what it still cannot.

## Why "constant body, namespaced attributes" and not "just log responsibly"

A message body built from a variable — `` `Tool ${name} failed` `` — defeats
the two things structured logging exists for: an operator cannot grep for
the literal event, and a dashboard cannot group by it, because every
occurrence has a different string. The variable belongs in an **attribute**,
where it has a stable key an operator or a dashboard can query by. A key
that is not namespaced (`errorCode` instead of `exception.type`) has the
same defect one level up: it collides with whatever the next feature calls
its own error code, and it does not sort next to the OTel-shaped keys
(`namzu.*`, `gen_ai.*`, `service.*`, `exception.*`) the rest of the
telemetry surface already uses.

## Six rules, two shapes of enforcement

`scripts/check-log-standard.mjs` enforces six of the nine checks named in
the original design. Four are decidable from syntax alone — a name is
either `console`, `process`, `getRootLogger`, or a literal `component` key,
regardless of what type anything resolves to. Two more, added in this
change, need the type checker:

- **Rule 3 — constant body.** The first argument to a confirmed `Logger`
  call may not be a template literal containing a substitution, nor a `+`
  concatenation.
- **Rule 4 — namespaced attribute keys.** Every key in the second argument
  must match `^(namzu|gen_ai|service|exception)\.` — including a computed
  key, which is resolved to a literal where possible (a `const` string, at
  most one import hop) and treated as a violation when it is not, rather
  than silently skipped.

Both turn on the same question: is the call's **receiver** actually a
`Logger`? A name-matching walk cannot answer that — `packages/cli/src`'s own
`Formatter` type has `.info()` and `.error()` methods with nothing to do
with logging — so both rules resolve the receiver's declared type against
the real `Logger` interface in `packages/sdk/src/utils/logger.ts`,
structurally (`Logger` has never been a nominal type here), including
through an alias (`const l = logger`) or a destructure (`const { info } =
logger`).

Rule 4's attribute-bag check applies the same discipline one level up: an
identifier or a function call standing in for the whole bag is trusted only
when its type is **structurally equal** to `LogAttributes` (assignable both
ways, not just into it) — one direction alone lets an object with an
unlisted property like `{ errorCode: string }` through, because a mapped
type over a template-literal key pattern has no fixed set of required
properties for a normal structural check to enforce against.

Both new rules are ratchets, the same enforcement shape as
`getRootLoggerCount` and `unnamespacedBindingCount`: an exact count in
`scripts/log-standard.json`, compared with `!==`, moved only by editing the
file. Neither carries a path-based exclude list the way `consoleAllowlist`
and `streamWriteAllowlist` do — `constantBodyExcludes` and
`namespacedAttributeKeyExcludes` exist in the config only as a permanently-
empty guard a test fails against, because a path excluded from "is this
receiver a Logger" or "is this key namespaced" is a path where neither
guarantee holds, and the six-rule gate should not have anywhere to hide
that.

## What is measured, not assumed

Both ratchets were non-zero when the rules landed: 87 sites with a
non-constant message body, 802 attribute keys that do not match the
namespace pattern, across `packages/*/src` (the same scope the two
allowlists already use — `Logger` is not an SDK-only type). That was a real,
pre-existing gap the rules made visible for the first time, not a defect in
the rules themselves; driving either number to zero was its own follow-up
task, the shape `LOG-09` already was for `unnamespacedBindingCount`.

**Rule 3 is now at zero, and that changes what it is.** LOG-21 rewrote all
87 sites: each message became a constant and each interpolated value moved
into a namespaced attribute beside it. A ratchet at zero is no longer a
budget being spent down — it is a floor, and the *first* new template
literal in a `Logger` call fails CI rather than the hundredth. Rule 4 is
still above zero and still being worked down.

Two things that rewrite taught, both worth keeping:

- **The value has to land somewhere.** Constantising `` `Tool completed:
  ${toolName}` `` to `'Tool completed'` and stopping there deletes the only
  copy of the tool's name from the record. Where the neighbouring attribute
  bag already carried it, the message alone changed; where it did not, the
  value moved into a `namzu.*` key in the same edit. A constant body that
  costs an operator the identifier is a worse record, not a compliant one.
- **A test that matched the interpolation goes quiet, it does not go red.**
  `expect.stringContaining('"a" already registered')` fails loudly and gets
  fixed. `r.message.includes('Connector instance created')` keeps passing
  while the id it used to imply is gone — the substring is now the whole
  message. Both call sites were tightened to exact equality on the message
  plus an assertion on the attribute, which is what the record actually
  promises now.

Both counts are also a property of the gate's own, deliberately non-strict
`ts.Program` (see that Program's own compiler-options comment in
`scripts/check-log-standard.mjs`): a stricter configuration resolves some of
the same receiver and attribute-bag expressions to different types, and
would report a different count from the same source tree. The 87/802
figures describe the gate's own answer, not a claim about what the
workspace's strict `tsconfig.json` would say if it asked the same
questions.

## What is explicitly UNENFORCED

**The gate cannot check where an attribute VALUE came from.** Rule 4 proves
a key is namespaced; it says nothing about what is inside the value bound to
that key. `logger.error('boot refused', { 'namzu.refusal.reason':
someModelOutput })` passes rule 4 completely — the key is namespaced, the
call is constant-bodied — and the gate has no opinion on whether
`someModelOutput` is safe to write into a log record verbatim. That is a
value-level concern (log forging, unbounded size, a secret), and it is the
runtime redaction/caps pipeline's job (`packages/sdk/src/utils/log/redact.ts`,
`caps.ts`, and the `LogAttributes` key-shape allowlist documented at
`docs/sdk/observability/logging.md`), not this gate's. A convention page
that claimed full coverage here would be wrong; this one does not.

A related, smaller gap: rule 3 checks the *literal shape* of the message
argument at the call site, not where it came from. `const msg = \`Tool ${name}
failed\`; log.error(msg)` passes rule 3, because the argument at the call
site is a plain identifier, not a template literal — the interpolation
already happened one line earlier. This is the same class of blind spot as
the attribute-value one above, one syntactic hop removed, and is named here
for the same reason: an unenforced gap that goes unnamed is a gap nobody is
watching.

## What is still out of scope

The original design named nine checks; six are enforced as of this change.
The remaining three were also named as needing the type checker and are
left for a later task.
