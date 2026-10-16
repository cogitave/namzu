---
"@namzu/cli": minor
---

Add opt-in automatic model selection. Set `model: auto` and a `routing` block (`default`, optional `tiers.fast` and `tiers.big`, `strategy`, `thresholds`, `timeoutMs`) in your user or managed config, and the CLI asks your configured `decision` model how big each task is and runs it on the matching model, so short chat can use a small local model and large changes a bigger one. Any failure to decide, a timeout, or an unavailable tier runs `routing.default`; it never falls to the small or big model. `model: auto` without `routing.default` is a config error at load. Nothing changes unless you set these keys: the default behaviour is untouched, project config and the environment cannot set them, and `--model` or picking a model by hand turns auto off. Pals resolve `auto` once, to `routing.default`, when a session starts.
