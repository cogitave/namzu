# @namzu/decision

## 0.3.0

### Minor Changes

- 90c911e: Add an optional `decision` config block that gives the host and Pal agents a `decide` tool backed by a System-1 decision model (yes/no, choice or score). Two providers are supported: `provider: azure` (`endpoint`, `deployment`, optional `tokenEnv`, default `AZURE_FOUNDRY_TOKEN`) and `provider: http` (`url`, optional `model`, optional `apiKeyEnv`). The config names the environment variable that holds a credential, never the credential itself. The tool is advisory and fail-open: if the model is unreachable or errors, the tool tells the agent to proceed and the turn does not fail. Without the block nothing changes. Nothing needs to be done to upgrade.

## 0.2.0

### Minor Changes

- a8a751a: New package `@namzu/decision`: a provider-agnostic interface for System-1 decision models (fast, non-generative models that return a yes/no probability, a choice with per-option probabilities, or a score), with an Azure AI Foundry Microsoft-Decision-1 driver. Nothing to do to upgrade; this is a new, dependency-free package. Yes/no is verified against the live API; the choice and score request shapes are provisional.
