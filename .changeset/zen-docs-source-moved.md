---
'@namzu/zen': patch
'@namzu/cli': patch
---

The Zen and Zen Go catalogue refresh read its two documentation pages from a path that no longer exists upstream (`services/www`, now `services/site`), so every launch logged a 404 warning and kept the bundled catalogue; it reads the new path. A refresh that fails for a reason worth a warning now warns once every six hours and logs at `debug` in between; `NAMZU_HOME/cli/zen-catalogue-failed.json` holds the time of the last warning.
