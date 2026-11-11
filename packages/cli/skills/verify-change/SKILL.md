---
name: verify-change
description: Prove a change works by running the thing that changed, not by reading it. Use before you tell the person a change works or is done, and when they type "does it work?", "test it", "make sure it runs". Not for edits to docs or comments only.
invocation: both
---

# Proving a change works

A change is proven by exercising the real thing that changed. Reading the code
is not proof, and a passing test run is not proof of the behaviour you changed
unless that test reaches it.

## Steps

1. **Say what should be true.** In one sentence, what does this change make
   true that was not true before? ("`export --json` prints one object per
   line.") Everything below is measured against that sentence.
2. **Find how the project is really run.** Read its instructions file, its
   README and its scripts (`package.json` scripts, a Makefile, a task runner).
   Use those commands, not a guess.
3. **Pick the smallest real exercise.** Run the command, call the endpoint,
   open the screen, feed the input that reaches the changed behaviour. Prefer
   one that would fail without your change. Run it and read what came out.
4. **Compare.** Put what happened next to the sentence from step 1. Do they
   agree? A different result from the one you expected is a result, not noise.
5. **Run the project's own check, plainly.** Run its test, lint or build
   command as a command of its own: nothing after it that could hide how it
   ended (no pipe into `tail`, no `;` or `||` with a second command, no
   background run). The kernel records the turn's checks and reads the exit
   status; a hidden status is recorded as inconclusive. If the output is long,
   read it afterwards from where it was printed; do not trim it on the way.
6. **Report one verdict, with evidence.**
   - **It works.** What you ran and what you saw.
   - **It does not.** What you saw instead, and where it differs.
   - **It could not be exercised.** Exactly why (no credentials, no display,
     needs a service that is not here) and what a person would have to do.

## Never

- Report success from reading the code.
- Weaken, skip or delete a test to get a pass.
- Call a check "passing" when you did not see its output end.
- Round an unclear result up. If you cannot tell, say so.
- Run something that deletes data or spends money to prove a point; use a
  scratch copy or stop and ask.

## Not for

A change that only touches documentation or comments: there is nothing to run.
Say so and stop.

## Example report

> **Verdict: it works.** The change makes `export --json` print one object per
> line. I ran `node dist/bin.js export --json` on the sample folder: three
> lines, each a complete JSON object. Then `pnpm test` ran on its own and
> ended with 142 passed, 0 failed.

> **Verdict: could not be exercised.** The fix is in the upload retry. Trying it
> needs the staging bucket and its key, which are not set here. `pnpm test`
> passes (31 passed), but its tests stub the network. A person with the key
> should run `pnpm upload:sample` and check that a dropped connection retries.
