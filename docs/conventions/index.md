---
okf_version: "0.2"
---

# Conventions

Ratified rules about how code is written here, extracted when a session's
decisions turn final. Each file is one rule with the evidence that produced it —
a rule with no incident behind it is a preference, and preferences do not belong
here.

Read the rule that matches what you are about to change before you change it.

## Why no page here carries a `resource:`

The documentation standard's `resource:` names the code a document describes,
and the gate fails the build when that code has commits newer than the
document. Every page here had one, pointing at the file where its incident
happened.

That is the wrong subject, and the gate says so by firing. **A convention is a
rule about reasoning, and no file can make one false.** `refuse-do-not-degrade`
would be exactly as true if the driver that produced it were deleted;
`one-site-is-not-every-site` is not a claim about a checkpoint type. What the
pointers actually did was demand a re-read every time an unrelated line moved in
a file that happened to be the scene — three times in six hours on one night,
and each time there was nothing to re-establish.

The gate's own guidance warns that a churning sentinel trains everyone to wave
the failure through, which is the failure mode of a check that fires where
nothing is wrong. So the key is gone from this directory as a class rather than
re-dated page by page, and the reasoning lives here once instead of eight times.

**Point `resource:` at code whose change could make the document wrong, not at
code the document happens to be about.** An absent key honestly reads as "no
code can invalidate this", which is the true statement for every page in this
folder — the same reason the standard says to omit `verified:` rather than guess
it.

A page here would earn a `resource:` back by describing a specific mechanism
rather than a way of thinking. None does today, and a page that did would
probably belong under `docs/sdk/` instead.

## The rules

### Declarations and reachability

- [A declaration nothing drives is a defect, not a roadmap](declared-but-undriven.md)
  — a field read by no code path is a lie the type system tells. Fourteen
  instances in one week.
- [Reachability is its own property, and it needs its own test](reachability-is-its-own-property.md)
  — the behaviour is covered; the hop from the surface a host builds is not.
- [Finding an emitter is not evidence that every path reaches it](one-site-is-not-every-site.md)
  — the some-sites case, plus: how many shapes does this concept have?
- [Rendering two things in a ternary destroys the state of both](alternation-unmounts-state.md)
  — and the guard written to prevent it did it again. Only alternation
  destroys; a conditional sibling does not.

### Refusing rather than degrading

- [Refuse, do not silently degrade](refuse-do-not-degrade.md) — a capability
  that quietly does nothing is worse than one that errors.
- [An optional dependency may degrade a feature, never a check](an-optional-dependency-may-not-degrade-a-check.md)
  — a default fallback turned "I cannot establish this" into "this is
  satisfied".

**A deliberate omission is not the same shape as a missing feature, and a new
capability does not retroactively license it.** `packages/sdk/src/provider/errors.ts`
and every one of the six provider clients (`openai`, `anthropic`, `ollama`,
`bedrock`, `openrouter`, `lmstudio`) refuse to attach `cause` to a classified
provider error, on purpose: a vendor SDK builds its own error message FROM the
response body, so a credential the upstream echoed back is already inside
`err.message` before any of this code runs, and a `cause` survives every
logger that serializes an error chain. `utils/log/exception.ts` shipping a
bounded, cycle-safe `cause` walk for logging is not evidence that walk is now
safe everywhere it was previously refused — the mapper existing does not
override the reason the omission exists, and each client's own regression
test (plus `packages/sdk/src/provider/__tests__/errors.test.ts` for the
shared function) is what keeps a future "finally something walks `cause`"
from reading as permission.

### Tests that prove something

- [Mutate every test](mutation-check-every-test.md) — and a unit test on a
  helper never proves the caller invokes it. A kill by one unit is the fixture
  discriminating, not the code. Write the second round to find gaps rather than
  to confirm the first: twenty aimed mutations all died, and ten written with
  the opposite intent produced seven survivors.
- [A test can be sound and still be about the wrong thing](sound-about-the-wrong-thing.md)
  — right path, wrong observer, wrong moment. A live run is not exempt.
- [A fixture unlike production tests a system that does not ship](fixture-must-match-production.md)
  — the defect lives in a branch an empty listener set never enters.
- [A check that cannot fail is worse than no check](a-check-that-cannot-fail.md)
  — it teaches the next reader that the checks here are decoration. Includes the
  loose matcher: `toContain(old)` cannot see a change that only adds around it.
  And the check that was never asked: a suite excluded from its own runner,
  reported as a pass. A separated suite announces its absence to nobody.

### Reading the evidence

- [The answer is usually already written, near where it is needed](read-the-neighbour.md)
  — five defects in one session whose reasoning was seventeen lines below, two
  columns away, forty lines above. Unapplied knowledge, not missing knowledge.
- [Verify the claim, including your own, including a comment's](verify-claims-including-your-own.md)
  — including a report's, including your own from an hour ago.
- [A sentence a test could falsify is a claim, not documentation](a-falsifiable-comment-is-a-test.md)
  — its mirror, aimed at writing rather than reading. The tell is grammatical: a
  sentence naming a condition and an outcome is a test you have not written.
  Committed by an agent an hour after it caught the same shape in its own
  harness.
- [Read back the protection you set, and refuse if you cannot](read-back-the-protection-you-set.md)
  — asking for a permission is not holding one, and a wrong value is visible
  where an unset file mode is not. Includes the platform axis: a readback inside
  a platform branch cannot fail on any machine but one, so the predicate has to
  be pure. Deleting a mode check killed no test on the machine it was written on.
- [Never filter a verification down to something that can read green](never-filter-a-verification.md)
  — the check ran and its answer was invisible. Three incidents in one day.

## How to add one

When a session's decisions turn final, promote the rules that apply beyond that
session's own slice. A rule that is only about that session's code belongs in
the code as a comment instead.

Every file here carries front matter the documentation gate reads: `uid`,
`title`, `description`, `type`, `diataxis`, `owner`, `status`, `timestamp` and
`lastReviewed`. Run it with `pnpm docs:check`.

**Do not add a `resource`.** This paragraph used to instruct the opposite — name
the code the incident lives in — which is what put a sentinel on all eight pages
and is the practice the section at the top of this file removed. The two
sentences contradicted each other for the length of one commit, which is a
smaller version of the thing conventions exist to stop: a reader following the
instruction here would have rebuilt exactly what the reasoning above explains
away.

`verified` records who last re-established a rule against source, and when. It
is absent on most of these, and that absence is accurate rather than an
oversight — a rule carrying no `verified` key has been read but not re-checked.
