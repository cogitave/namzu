---
"@namzu/cli": minor
---

Make Auto a visible model choice in the terminal and in Desktop. With a `routing` block in your user config, the `/model` picker lists "Auto (picks a model for each task)" first, `/model auto` (or "switch model to auto", "auto'ya geç") turns it on, and Desktop's composer model picker offers the same row; `model: auto` stays the way to make Auto the default every time. Choosing a model by hand turns Auto off for that conversation and choosing Auto turns it back on; a launch `--model` still wins for that launch. Auto chosen in the terminal lasts for the launch, and Desktop remembers it per conversation. Nothing changes for configs without `routing`: asking for Auto there now says in plain words that it needs a `routing` block. The ACP runtime gains an optional `auto` field on the provider status and a `namzu/providers/select_auto` method; Pals and external engines are never offered Auto.
