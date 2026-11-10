---
'@namzu/cli': minor
---

Connect a decision model from the terminal.

After you pick a model, Namzu offers once to connect a decision model (Yes, Not now, Don't ask again; Not now asks again at most once a day). Yes takes OpenRouter first (the decision models it lists live, with price per million input tokens and context length, using the OpenRouter key Namzu already has or asking for one; the test line adds latency and, when OpenRouter reports it, the cost of the test, and a model that rejects Namzu's questions is refused with a prompt to pick another), or an Azure AI Foundry resource, from one paste of the portal's "Keys and Endpoint" text, or your own HTTP server, tests the connection with one call (`Connected · 180 ms` or the reason it failed) and turns on `notify` and `skill`, with `memory` and `pick` only recording until you set them to `on`. The key is saved in the private credential store (`api-keys.json`, id `decision`), never in `config.yaml`.

`decision: true` in your user config now means "use the decision model I connected"; with nothing connected the terminal offers the connect flow once at start. The full `decision` block works as before. A project file still cannot set it, and `NAMZU_NO_DECISION=1` still turns everything off.

An Azure block with no `apiKeyEnv` and no saved key now gets its bearer token from `AZURE_FOUNDRY_TOKEN` when that is set, otherwise from `az account get-access-token`, cached until five minutes before it expires. `/status` shows one `Decision` line.

Nothing breaks: a config that names `apiKeyEnv` or `tokenEnv` behaves as before. A decision key saved by this flow is used by a block that names neither.
