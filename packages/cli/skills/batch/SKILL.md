---
name: batch
description: Split a large, mostly mechanical change (a rename, a migration, an API change across many files) into independent parts and have separate agents do them, each in its own checkout. Use when the person types /batch with such a change. Not for a change one agent can finish in one sitting, and not for work whose parts depend on each other.
invocation: operator
argument-hint: '<the change to make everywhere>'
---

# A change across many places, in parallel

This needs a Git repository (each helper works in its own checkout). Without
one, say so and stop.

$ARGUMENTS

## Steps

1. **Understand the change before you split it.** Find every place it touches
   (search, do not guess), and read two or three of them to see what the same
   edit looks like in each. Write the rule for one place in two sentences.
2. **Split into independent units**, by folder, package or file group, each
   something one helper can finish and check alone: a unit never needs another
   unit's result. Aim for 3 to 12 units of similar size, never more than 30.
   If the units depend on each other, or fewer than three exist, say this is
   not a batch and offer to do it in one go.
3. **Say how each unit is checked.** The project's own test or build command
   for that part; find it first and run it once on the untouched tree so you
   know what "passing" looks like.
4. **Show the plan and wait for a yes**: the rule, the list of units with their
   files, the check per unit, and how many helpers that means. Warn that each
   helper spends its own tokens.
5. **Start the helpers** with the `Agent` tool, one call per unit, each with
   `workspace: "worktree"` so it has its own checkout, started in the background
   where the tool allows it, at most 5 at once. Give each a full brief: the
   rule, its unit's files, how to check, "commit your work on your branch; do not
   push; do not touch files outside the unit", and what to report: the branch
   and the check result.
6. **Collect the results** as they finish. A unit that failed its check is
   reported as failed, with the helper's own words; do not retry it silently
   more than once.
7. **Report one table**: unit, branch, check passed or failed, files changed.
   Offer next steps (look at a branch, merge the passing ones one by one,
   open pull requests with `/pr` from each branch), and do not do them until
   asked.

## Never

- Run more helpers than the person agreed to, or start before they said yes.
- Push, merge or open a pull request on your own.
- Let a helper change files outside its unit, or share one checkout with
  another helper.
- Remove a checkout that holds commits; leave them and say where they are.
- Do anything that cannot be undone (delete data, push, spend money) without
  asking first.
