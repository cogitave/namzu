---
'@namzu/sdk': patch
---

Static file tracers (`@vercel/nft`, which Next.js standalone output uses) no longer list the repository's `.json` and `.md` files as runtime assets of the SDK. The two memory stores built entry paths in a form the tracer read as a wildcard; they now build them so it has nothing to expand. The files the stores read and write are unchanged, so nothing needs doing on upgrade, and a host that added `research/**` or `docs/**` tracer ignores for this can remove them.
