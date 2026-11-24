---
name: simplify
description: Tidy the code that just changed, then apply the fixes: reuse what already exists, remove needless steps and copies, and pick the cheaper way where it is clear. Use when the person types /simplify, or asks to clean up, tidy or simplify the change. Not for finding bugs (use review-changes) and not for code outside the change.
invocation: operator
argument-hint: '[files or what to focus on]'
---

# Simplifying a change

Make the change smaller and plainer without changing what it does. This is
about quality, not defects: a bug you notice on the way is reported, not hunted.

$ARGUMENTS

## Steps

1. **Fix the scope.** The working tree against its base (`git diff` and the new
   files), or exactly what the person names. Say which in one line. Leave
   everything else alone, even when it could be better.
2. **Read each changed place whole**, with what it calls and what calls it.
3. **Look for these, in this order:**
   - **Reuse.** A helper, type, constant or pattern the project already has
     that the change rewrote. Search before you decide it does not exist.
   - **Needless parts.** Variables, parameters, options, wrappers or branches
     that nothing needs; code that cannot be reached; a copy of a block that
     should be one function used twice.
   - **Cost.** Work done in a loop that could be done once, a file read twice,
     a list scanned where a lookup would do, only where the gain is plain.
   - **Level.** A change made in the wrong place (a special case in a caller
     that belongs in the function it calls), or an abstraction with one user.
   - **Words.** Names and comments that say what the code does instead of why,
     or that no longer match it.
4. **Apply the fixes yourself**, one small edit at a time, keeping the
   behaviour. Do not change public names, file formats or output unless asked.
5. **Run the project's own check, plainly**: its test, lint or build command as
   a command of its own, with nothing after it that could hide how it ended (no
   pipe, no `;` or `||`, no background run). Read the end of its output. If it
   fails because of your edit, put the edit back or fix it.
6. **Report** in a few lines: what you changed and why, what you left alone on
   purpose, and the result of the check.

## Never

- Change behaviour, an interface, or something outside the change.
- Delete a test, or weaken one, to make the check pass.
- Rewrite working code for taste. "Different" is not "simpler".
- Do anything that cannot be undone (delete data, push, install, spend money)
  without asking first.

## Not for

Defects (use `review-changes`) and proof that it runs (use `run`).
