---
'@namzu/ollama': patch
'@namzu/lmstudio': patch
---

Nothing a consumer can observe changed. Both drivers still report `inputPrice: 0` and `outputPrice: 0` for every model they serve, and they are the reason that value had to keep meaning what it means.

Both talk to a server the operator runs locally and bill per token exactly never, so zero is the true rate rather than a placeholder — the one case where the answer is known for every model that could ever appear. `rates.source.json` records the same claim as `unmetered: true`, in its own words: such a driver "is priced at zero, which is KNOWN-free and therefore distinct from unknown".

The change is a comment at each site saying so. That comment is also what a source scan in `@namzu/sdk` now reads to tell an honest zero from a manufactured one.
