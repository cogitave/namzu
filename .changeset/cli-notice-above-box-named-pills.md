---
'@namzu/cli': patch
---

The update notice (`✓ Updated to X · restart to use it`, `Update available! Run: …`) now sits on its own row directly above the input box, at the right edge, instead of taking the place of the model name under the box; it is green with a check once an update is installed, is cut at 60 percent of the width on a narrow terminal, and is hidden while an urgent or error notice shows. The model name stays on the row under the box while an update shows. The background pill under the box names what is running: `2 shells` and `1 monitor` replace `3 bg`. Anything that matched the text `N bg` on screen now sees `N shells` or `N monitors`.
