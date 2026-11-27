---
'@namzu/cli': patch
---

The desktop host's skill methods (`namzu/skills/stage`, `install`, `create` and `remove`) refused every call as if a Pal had made it, because the check compared an absent Pal (`null`) with `undefined`. They now work in an ordinary folder and still refuse a Pal's.
