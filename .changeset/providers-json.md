---
'@namzu/cli': minor
---

run-stream gains a `--provider` flag (override the persona's configured provider
for the turn, alongside --model). New `providers-json` command prints every
registry provider with its detection state, default model, and a best-effort
live model list (`{provider,label,detected,default,models[]}[]`) so a host UI can
build a dynamic provider/model picker instead of a hardcoded list. listModels is
probed per detected provider with a 3s race + free-text fallback. The listing
path registers the vendor package (ensureRegistered) before constructing the
provider, so a detected provider returns its real model catalog instead of an
empty list — without it ProviderRegistry.create throws "Unsupported provider
type" and the picker silently degrades to free-text for every provider.
