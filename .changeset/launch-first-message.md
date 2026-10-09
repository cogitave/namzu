---
"@namzu/cli": minor
---

Add `--message <text>` to the interactive `namzu`: the session sends the text once, as a plain prompt (a leading `/`, `!` or `#` is not a command), when its composer is ready, with the provider, model, effort and mode chosen by the other launch flags. It is session-only, shown as the first user message, and not sent again on resume or reload. Before a subcommand it is refused with exit 64, like `--model`. Nothing changes for callers that do not pass it. Pass `--message=<text>` when the text may start with a dash.
