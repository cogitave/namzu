---
"@namzu/evals": patch
---

The kernel suites remove each case's scratch directory when the case ends and
keep the run's state inside it. Every case used to leave a directory with a
full run tree in the system temporary directory.
