---
"@namzu/evals": patch
---

The kernel suites remove each case's scratch directory when the case ends and
keep the session state inside it. Every case used to leave a directory with a
full state tree in the system temporary directory.
