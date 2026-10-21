---
"@namzu/lmstudio": patch
---

The package description said `@namzu/lmstudio` supports tool use. It does not: the driver never reads `params.tools` and reports `supportsTools: false`, so a turn on LM Studio is chat only. The description now says so. Nothing to do to take this; to let Namzu work with files and commands, switch to a provider that takes tools.
