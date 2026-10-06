---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Add a connected computer observation to `PalSystemPromptOptions.computer`, with the current control mode, so hosts can describe an existing device independently of permission to execute tools.

Fix Pal chat composition when the operator holds its connected computer. The Pal now receives its actual connected/control state instead of being told the computer is unavailable. Operator-held chat retains zero guest tools and performs no guest inspection or allocation; Return control admits the existing guest capabilities on the following turn.
