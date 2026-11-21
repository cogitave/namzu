---
'@namzu/sdk': minor
---

A shell write into the session scratch folder through `$NAMZU_SCRATCH` (`printf x > $NAMZU_SCRATCH/out.csv`) no longer asks "Outside the working directory". A test run piped through `tail` or `grep` whose output shows the runner's own summary (node, vitest, jest, pytest, cargo, go), or that uses `set -o pipefail` or `exit ${PIPESTATUS[0]}`, is counted as read, so the end-of-turn line no longer says the pipe hides whether it passed after a passing run (a failing summary now counts as a failure). A saved shell rule covers a line whose other commands only read, and declines a line that writes a file through a redirection. New exports: `isReadOnlyCommandLine` and `writesThroughRedirection`.
