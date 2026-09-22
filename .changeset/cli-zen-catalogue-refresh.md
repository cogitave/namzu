---
"@namzu/cli": minor
---

Refresh the Zen and Zen Go model catalogue in the background on every launch. The interactive TUI, `resume`, `run`, `run-stream` and `acp` start one refresh that never delays startup, gives up after 30 seconds and is cancelled when the command ends. When it lands, the model picker and routing use it immediately, including for providers already built, and it is saved as a last-good copy at `cli/zen-catalogue.json` under `NAMZU_HOME`. When it fails, the session keeps the last-good copy, or otherwise the bundled catalogue, and logs one warning. A damaged copy on disk is ignored rather than read in part. A model the service serves with no known wire format is not offered in the picker, since the CLI has no setting that names a protocol for it.

This is on by default, and each of those launches now reads OpenCode's documentation pages, models.dev and the two Zen `/models` endpoints over the network. To keep the previous behaviour (bundled catalogue only, no network read), set `modelCatalogueRefresh: false` in `~/.namzu/config.yaml`, or `NAMZU_MODEL_CATALOGUE_REFRESH=0`.
