# Compact model list, no Default row, continue from the last model (2026-10-08)

Run on the design preview (`/preview`), Playwright chromium, 1100x800, dark and light.
`proof.mjs [theme] [mode] [tag]` drives it; modes `versions` (long list of versioned models),
`codex` (the Codex engine list) and `aliases` (the second external engine, alias rows marked
`current`) are catalogue mocks in `src/dev/preview.ts`.

| List | Rows today | Shown first | Fold |
|---|---|---|---|
| Long versioned list | 14 | 4 (Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.1) | Older models (10) |
| Codex engine | 8 | 3 (GPT-6.1 Sol, Astra, Luna) | Older models (5) |
| Alias engine | 11 | 4 aliases | Older models (7) |

Measured in each run (all six passed, `errors []`):

- A new conversation with nothing ever chosen settles on the recommended row (Codex, alias
  engine) or the first current row (long list): trigger reads GPT-6.1 Sol / Opus 5.5 / Haiku 5.5.
- The list opens compact; the fold expands in place; ArrowDown from the checked row passes through
  every current row into the older ones (7 presses, no gap).
- Picking an older model with Enter pins it under the current rows ("Older models (9)" for the long
  list, fold count excludes the pinned one).
- Search "opus 4" (long list) finds the 4.x rows although they are folded.
- After a page reload a new conversation starts with the last pick (Opus 4.8, GPT-5.5,
  Opus 4.8).

Screenshots (`<list>-<theme>-N-*.png`): 1 compact, 2 expanded, 3 checked older model pinned,
4 search, 5 a new conversation after reload continuing from the last pick.
