---
'@namzu/cli': patch
---

The terminal's `code_analysis` tool, which bundles `@namzu/analysis`, answers more honestly and more correctly. After an edit it finds the new string or caller without an `index` call; it no longer reports `complete` when it skipped ignored or `.gitignore`d directories, `.html` / `.vue` files, declaration files or calls it could not name; `dist`, `build`, `out` and `.next` are no longer indexed by default (name one as the path to search it); files with a syntax error keep the code around the error; methods are listed as `Svc.init`. Its first call in a project rebuilds the index once. Nothing to configure.
