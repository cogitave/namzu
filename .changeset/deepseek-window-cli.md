---
'@namzu/cli': major
---

Compaction no longer fires every few turns on the DeepSeek API: the driver's 1M window is used, and `deepseek-flash` replaces `deepseek-v4-flash` as the default DeepSeek model (set `NAMZU_MODEL=deepseek-v4-flash` or `--model` to keep the old one). A model id ending in `[1m]` declares a one-million-token window for any model and is stripped before it reaches a provider (`--model`, `/model`, `NAMZU_MODEL`, `NAMZU_SUBAGENT_MODEL`, `NAMZU_SMALL_MODEL`, config); `NAMZU_DISABLE_1M_CONTEXT=1` turns that off.

Breaking: `NAMZU_AUTO_COMPACT_WINDOW` and `compaction.autoCompactWindowTokens` now take `786k`/`200000`/`1m`, a value under 100,000 is raised to 100,000 and one over 1,000,000 lowered to 1,000,000 (each with a one-line warning at launch), and a value that is not a size is ignored with a warning instead of refusing to start. If you set a window below 100k, set `compaction.contextWindowTokens` instead. `/context` says when the model's own window capped the setting.

`NAMZU_EFFORT_LEVEL` is now case-insensitive, accepts `med` for `medium`, and treats `auto` and `unset` as no override. `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` (the vendor SDK's own variables) point the Anthropic provider at an Anthropic-compatible endpoint: the token goes as a bearer credential, nothing saved is ever sent to another host (a base URL with no token or key variable is ignored with a notice at launch, and saved sign-ins keep going to the vendor's host; so is a base URL that is not a URL), and `/status` shows `Anthropic (Claude) via <host>`. Saved credentials and a vendor-host base URL behave as before. `ANTHROPIC_AUTH_TOKEN` is read only together with a third-party `ANTHROPIC_BASE_URL`; it is not a detected sign-in.
