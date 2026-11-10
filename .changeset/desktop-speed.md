---
'@namzu/desktop': patch
---

Namzu Desktop installs and opens faster and quits sooner, with no feature removed: the installer's bundled runtimes no longer carry source maps, type declarations, tests or READMEs (about 14,000 fewer files); the installer of an already installed update is removed from the updater cache; saved folders reconnect three at a time while the windows load; quitting stops its parts together; and a Pal computer that keeps failing is polled less and less often. Nothing to change on your side.
