---
'@namzu/cli': minor
---

`namzu acp --desktop` gains four methods for the Desktop conversation header: `namzu/conversations/rename` (`{ sessionId, title }` returns `{ title }`; an empty title restores the title derived from the first message), `namzu/conversations/fork` (`{ sessionId }` returns `{ id, title }`; refused while a reply is running or when there is nothing to copy), `namzu/conversations/markdown` (`{ sessionId }` returns `{ markdown, truncated }`, cut at 4 MiB of UTF-8) and `namzu/project/git` (returns `{ branch, subject }`, or `null` when the folder is untrusted, not a repository, git is missing or git takes over 3 seconds). All are new; existing methods and clients are unaffected. Each conversation method needs a trusted folder and a conversation this project owns, the same as archive.
