---
"@namzu/cli": minor
"@namzu/decision": minor
---

Add an optional `decision` config block that gives the host and Pal agents a `decide` tool backed by a System-1 decision model (yes/no, choice or score). Two providers are supported: `provider: azure` (`endpoint`, `deployment`, optional `tokenEnv`, default `AZURE_FOUNDRY_TOKEN`) and `provider: http` (`url`, optional `model`, optional `apiKeyEnv`). The config names the environment variable that holds a credential, never the credential itself. The tool is advisory and fail-open: if the model is unreachable or errors, the tool tells the agent to proceed and the turn does not fail. Without the block nothing changes. Nothing needs to be done to upgrade.
