---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Add optional `PalAppearance` preferences to saved Pal definitions and create/update inputs. Character and color selections persist in immutable profile revisions; existing records retain their absent appearance and hosts may choose their own display default.

The CLI accepts `--appearance <character>/<color>` on `pal create` and `pal update`, and the desktop ACP create/update extensions carry the same validated preference. Supported characters are `pixel`, `sprout`, and `spark`; supported colors are `green`, `blue`, `amber`, `violet`, and `rose`.
