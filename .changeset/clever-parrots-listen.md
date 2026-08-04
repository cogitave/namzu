---
'@namzu/sdk': major
---

`read`, `write` and `edit` are now contained to the working directory.

All three called `resolve(workingDirectory, input.path)` bare, so
`path: "../../.."` reached whatever sits above the working directory and the
tool used it. No sandbox had to be misconfigured for this — it holds with no
sandbox at all, which is the common case, so a model that asks for a parent
directory got one. `resolveWithin` existed the whole time and these three
never reached it; the search tools (`glob`, `grep`, `ls`) did.

A lexical check alone would not have been the fix. `atomicWriteFile` resolves
its destination and writes *through* a symlink deliberately, so that editing a
linked file updates the target rather than replacing the link with a regular
file. Paired with a lexical check that is check-then-follow: a link inside the
working directory pointing outside it climbs nothing on paper, and the write
lands outside anyway (CWE-59). Containment is therefore decided after
canonicalization, which is the ordering CWE-22 states as the mitigation for
the family: canonicalize, then validate the canonical form.

Two details the new resolver has to get right, because getting either wrong
breaks ordinary use rather than failing safe:

- The root can itself be a symlink — `os.tmpdir()` is one on macOS — so both
  sides are canonicalized. Canonicalizing only the candidate would refuse
  every path under a temp directory.
- The target may not exist yet, and `realpath` throws on a missing path. The
  deepest existing ancestor is canonicalized and the remainder appended
  lexically; the remainder cannot hide a link because nothing is there to be
  one.

This does not claim TOCTOU safety. A component swapped for a symlink between
the check and the open would still be followed — closing that needs
per-component `openat`/`O_NOFOLLOW`, which Node does not expose. The threat
addressed is a link that is already present.

**Migration.** If a host relied on these tools reaching outside
`workingDirectory` — reading a config beside the repo, writing to a sibling
output directory — those calls now fail with "Path escapes the working
directory". Point `workingDirectory` at a root that contains everything the
run legitimately needs. Sandboxed runs are unaffected: the sandbox has its own
root and its own resolver, and the host-side canonicalization deliberately
does not run on that branch.
