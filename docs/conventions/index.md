---
okf_version: "0.2"
---

# Conventions

Ratified rules about how code is written here, extracted when a session's
decisions turn final. Each file is one rule with the evidence that produced it —
a rule with no incident behind it is a preference, and preferences do not belong
here.

Read the rule that matches what you are about to change before you change it.

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

### Tests that prove something

- [Mutate every test](mutation-check-every-test.md) — and a unit test on a
  helper never proves the caller invokes it.
- [A test can be sound and still be about the wrong thing](sound-about-the-wrong-thing.md)
  — right path, wrong observer, wrong moment. A live run is not exempt.
- [A fixture unlike production tests a system that does not ship](fixture-must-match-production.md)
  — the defect lives in a branch an empty listener set never enters.
- [A check that cannot fail is worse than no check](a-check-that-cannot-fail.md)
  — it teaches the next reader that the checks here are decoration.

### Reading the evidence

- [Verify the claim, including your own, including a comment's](verify-claims-including-your-own.md)
  — including a report's, including your own from an hour ago.
- [Never filter a verification down to something that can read green](never-filter-a-verification.md)
  — the check ran and its answer was invisible. Three incidents in one day.

## How to add one

When a session's decisions turn final, promote the rules that apply beyond that
session's own slice. A rule that is only about that session's code belongs in
the code as a comment instead.

Every file here carries front matter the documentation gate reads: `uid`,
`title`, `description`, `type`, `diataxis`, `owner`, `status`, `timestamp` and
`lastReviewed`, plus an optional `resource` naming the code the incident lives
in. Where `resource` is set, the gate fails the build if that code has moved
since the rule was last touched. Run it with `pnpm docs:check`.

`verified` records who last re-established a rule against source, and when. It
is absent on most of these, and that absence is accurate rather than an
oversight — a rule carrying no `verified` key has been read but not re-checked.
