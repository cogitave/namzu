---
'@namzu/cli': minor
---

The model can now read what the conversation has cost, so "what did this cost?" is answered in one step instead of a search of the disk that ended in "I cannot say". A new read-only tool, `session_cost`, takes no arguments and returns the money spent so far and in the last completed turn (with whether the provider reported it or it is an estimate from list prices), the token totals, and a line naming what it leaves out (side requests such as the title, sub-agents' own conversations). Tokens with no known rate read "at least $X; N tokens have no known rate", and a route with no price at all reads "unknown", never zero. It is added to every session that keeps a conversation log, including an `exec --json` run with no session key; nothing is removed or renamed, and a host that lists tool names for the model will see one more.
