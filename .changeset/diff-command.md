---
'@namzu/cli': minor
---

Add `/diff`, which shows what is uncommitted in the working tree.

There was no in-session way to see what had changed. The answer was another terminal, and an operator who did not switch to one accepted a turn's work without reading it.

**It reports the working tree, and says so on every non-empty answer.** The obvious framing — "what this session changed" — is one the CLI cannot honestly make: the tool events carry a human-readable summary rather than a path, and parsing a path back out of prose would be a guess dressed as attribution. So the command answers the question it can answer and names it accurately, rather than answering a better-sounding one wrongly.

Two things it refuses to get wrong. A directory that is not a repository produces an empty diff from any naive implementation, and an empty diff reads as *working tree clean* — a claim about a repository that does not exist; this says it cannot tell. And `git diff` shows no untracked file at all, so a session whose entire output is new files would otherwise report changing nothing; untracked paths are listed separately.

The patch goes in the collapsible body with a byte cap, because a transcript is not a pager and a diff that scrolls the session away has answered by making the answer unreadable.
