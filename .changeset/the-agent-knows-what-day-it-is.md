---
'@namzu/cli': minor
---

namzu is told what day it is and which branch it is on

The kernel tells the model the working directory and the platform. It does not
tell it the date, and it says nothing about the repository. Both are facts a
coding agent needs constantly and cannot get right by guessing.

A model with no clock answers from its training cut-off. It writes that date
into a changelog entry, into a `last_updated` frontmatter field, into a
copyright header, and reasons about "the current version" of a dependency from
a year that has passed. Nothing about the output looks wrong — it is
confidently, quietly stale. The branch matters for the same reason in a
different direction: "commit this" means something else on a release branch
than on a scratch one, and a detached HEAD means a commit goes nowhere
reachable.

So every turn now carries a short block: today's local calendar date, and
whether the working directory is a repository, on which branch, or with a
detached HEAD. Sub-agents get it too, resolved when the child is built rather
than captured at startup, so a delegated task does not inherit a stale answer
from a session that began yesterday.

Local date, not UTC: your "today" is the one on your wall, and a machine behind
UTC would otherwise be told it is tomorrow.

Deliberately absent: anything about uncommitted changes. This block is the
cached prefix of every request, and a dirty-file count changes whenever the
agent saves a file — carrying it would re-key that cache on essentially every
turn to say something `git status` answers on demand. Date and branch change
rarely enough to be free.

Nothing to configure. Two `git` calls per turn, each bounded at two seconds;
a directory that is not a repository, a machine with no `git`, and a call that
times out all resolve to the block simply not claiming the fact.
