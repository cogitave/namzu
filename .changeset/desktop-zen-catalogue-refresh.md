---
'@namzu/desktop': patch
---

The free Zen models load again. Zen moved its catalogue endpoints to per-wire paths, so every launch's refresh failed and the model list stayed on the copy saved before the move, missing the models Zen offers now. The CLI bundled with the app reads the new paths (`@namzu/zen` 3.0.0), and the list refreshes on launch. A conversation set to a model Zen retired, such as `cat-jam-free`, needs a current one picked from the model list.
