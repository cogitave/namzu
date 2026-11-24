---
"@namzu/cli": patch
---

Under Auto, a turn that carries your own picture is no longer routed to a configured tier whose model cannot read it. When no tier reads images the default model runs, and if that one cannot either, the turn is refused naming it, as for a model you chose yourself.
