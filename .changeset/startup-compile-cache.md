---
"@namzu/cli": patch
---

Launches after the first reuse V8's compiled code for Namzu's own modules, which takes about 100 ms to 150 ms off the interactive terminal and `namzu exec`. The cache is kept in `cache/compile` inside the Namzu home (`~/.namzu`, or `NAMZU_HOME`), and only when that folder already exists; a read-only or unwritable home just runs uncached. Set `NODE_DISABLE_COMPILE_CACHE=1` to turn it off, or `NODE_COMPILE_CACHE=<dir>` to put it somewhere else. Deleting the folder is always safe.
