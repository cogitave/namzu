---
name: review-changes
description: Find defects in a change by reading it with care, and report only the ones you can show. Use before you hand over a change you made, or when asked "review this", "any bugs?", "look over my diff". Not for tidying working code, and not a substitute for running it.
invocation: both
---

# Reviewing a change for defects

A review looks for what is wrong, not for style. Every finding comes with the
case in which it fails, and has been checked before it is reported.

## Steps

1. **Fix the scope.** The working tree against its base branch (`git diff`
   against it, plus new files), or exactly what the person names. Say which
   in one line.
2. **Read whole, not just the diff.** Read each changed function in full and
   the callers and callees the change affects. A defect often sits in how old
   code meets the new.
3. **Write the failing case for each suspicion.** "This input or state gives
   this wrong result or crash." A suspicion with no such case is dropped.
4. **Check before you report.** Follow the code path for the case, or
   reproduce it in a quick run. Withdraw every finding that does not hold.
5. **Report, most serious first.** For each: the file and line, one sentence
   saying what is wrong, and the failing case.
6. **Say what you found and did not look at.** If nothing survived, say so
   plainly, and name what you did not read or run.

## A thorough review

When the person asks for a thorough review and the `Agent` tool is available,
hand independent parts of the change to sub-agents: one finds defects, another
tries to refute each finding. Report only the findings that survived, and say
how many were refuted. Without the tool, do both passes yourself.

## Never

- Pad the report with preferences, naming or formatting.
- Report a finding you could not make concrete.
- Rewrite code that was not asked for: a review reports, it does not fix.
- Step outside what the person's permissions allow, or do anything that cannot
  be undone (delete data, push, install, spend money, touch a live service),
  without asking first; use a scratch copy.
- Treat a review as proof the change works. That needs it to be run.

## Not for

Simplifying or tidying code that works, and not a stand-in for running the
change: use `verify-change` for that.

## Example report

> Scope: working tree against `main`, 3 files.
>
> 1. `src/cart/total.ts:48` The discount is applied to the already-discounted
>    price. Failing case: a cart of one 100.00 item with a 10% code gives 81.00,
>    not 90.00. Confirmed by running `totalOf` on that cart.
> 2. `src/cart/store.ts:112` The error from `save` is dropped. Failing case: the
>    disk is full, `save` rejects, the caller shows "saved". Confirmed by
>    following the call at `src/cart/ui.ts:30`, which never reads the result.
>
> Nothing found in `src/cart/format.ts`. I did not read the migration scripts
> or run the integration tests.
