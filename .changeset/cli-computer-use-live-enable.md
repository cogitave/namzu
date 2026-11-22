---
"@namzu/cli": minor
---

Turning on `computerUse.enabled` now works in the conversation you already have open. Before, the computer tool was added only when a conversation started, so enabling it in `/config` or Settings did nothing until a new one. The switch is now read before every message: it applies from your next message, and turning it off takes the tool out again. The desktop helper is started only the first time the switch is on. The model is also told, in one fixed line, that computer use is a switch you control and how you turn it on. The default is unchanged (off). `/config computerUse.enabled` now says "Applies from your next message."; `computerUse.deniedApps` still applies to new conversations. Nothing needs to change for existing configurations.
