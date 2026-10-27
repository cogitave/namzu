---
'@namzu/cli': patch
---

A tool server that finishes connecting after the session has closed is now closed instead of being mounted. `/mcp` says `1 tool` for a single tool and leaves out the `0 unavailable` count when every server is up. A reply paused by a lost connection no longer rewrites an older pause line once a pause of a different kind has appeared or the run of automatic tries has started over. Nothing to change on your side.
