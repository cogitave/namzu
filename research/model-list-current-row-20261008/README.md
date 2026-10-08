# Model list without a "Current model" section (2026-10-08)

Playwright (proof.mjs, run from packages/desktop) against http://127.0.0.1:5173/preview, 1100x760, clipped to the popup.

- dark-in-use-provider.png, light-in-use-provider.png: the list of the provider in use; its row carries the check, its tab carries a small dot.
- dark-other-provider.png, light-other-provider.png: the same popup after switching to the other provider's tab; the provider in use keeps its dot, the list shows no "Current model" heading, no extra row and no check. Console: `.model-picker-current` count 0, text "Current model" count 0.

Why nothing else depended on the removed block: it was rendered after the list and used only `selectedModel`/`hasSelectedRow`, which fed nothing else (keyboard focus uses the radio group's checked row; the Default row comes from the catalogue). Those two locals are gone. The trigger label still reads the saved choice. The provider column had no "in use" marker, so tabs gain `data-in-use` and a 6px dot.

Labels: Desktop shows the catalogue's `name`. The Codex harness already normalises it (codexModelLabel); the API-provider path (`desktopModelCatalogue`, packages/cli) did not, so "GPT-5.6-Sol" arrived as written. `modelListLabel` now applies the same rule there, only to names that start with "GPT-", and never to a name equal to its id. Table (tests in desktop-model-catalogue.test.ts): GPT-5.6-Sol -> "GPT-5.6 Sol"; GPT-5.6-mini -> "GPT-5.6 mini" (a trailing word like Sol); GPT-5.6-Codex-Max unchanged (two words after the number); gpt-4o, gpt-4-turbo (lowercase = an id-style name), o3-mini, Claude Opus 5.5, qwen2.5-coder, llama-3.3-70b unchanged.
