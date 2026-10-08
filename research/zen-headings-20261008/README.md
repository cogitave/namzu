# Zen model headings (2026-10-08)

Proof that Zen's free models and API-key models sit under separate headings in the Desktop model list.
`proof.mjs` drives the live design preview (`http://127.0.0.1:5173/preview`, Playwright, actual renderer) against the new
"Sample Zen" provider in `packages/desktop/src/dev/preview.ts` (two free rows, two key rows, one unpriced row).

Run: `node research/zen-headings-20261008/proof.mjs .`

- `dark-zen.png`, `light-zen.png`: "Free", "API key" and "Other models" headings in the 11px group-heading style, between rows. The Default row stays on top; "Limits not published yet" stays on its row; no per-row "(API key)".
- `dark-zen-search.png`, `light-zen-search.png`: searching "reasoner" keeps only the "API key" heading (the other groups have no match).
- Console: 6 radios for 3 headings (headings are not rows); ArrowDown from the last free row lands on "Sample Pro", skipping the "API key" heading.

## Review follow-up

`dark-search-sample.png`, `light-search-sample.png`, `dark-search-api-key.png` and `light-search-api-key.png` show a group heading indented under the provider legend in search, and "api key" finding the key rows by heading. Taken with a scratch script, not `proof.mjs`.
