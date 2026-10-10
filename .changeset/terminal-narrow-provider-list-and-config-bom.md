---
"@namzu/cli": patch
---

The terminal app reads a `namzu.config.json` (and the user and managed settings files) saved with a leading byte-order mark, which Windows editors add, as if the mark were absent; it used to refuse the file as invalid. A settings file it cannot parse is now named the way a person finds it ("namzu.config.json in this project", `~/.namzu/config.yaml`, or the managed file's path) with the line and column, and the YAML message no longer carries the parser's wording unless you pass `--debug`. The provider list no longer squeezes a source to one character at 40 columns: below 63 columns the source is drawn under the provider's name. In the model list a long model name is no longer cut short to make room for "(current)" and "(default)"; the marks move to the line under it. No setting or flag changes.
