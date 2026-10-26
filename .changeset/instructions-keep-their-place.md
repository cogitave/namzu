---
'@namzu/sdk': patch
---

The project instructions a host supplies through `ProjectInstructionContext.prepareInitialSnapshot` keep one place in the conversation. Before, an unchanged snapshot was inserted again before every new user message and the old copy dropped, so the instructions moved to the tail on each turn and a provider's prompt cache could reuse nothing after their old position. Now a snapshot equal to the one the history holds is left where it is; a changed one is sent once, just before the turn's new message, and replaces the old copy. Nothing to do on upgrade; a host that read the position of the instructions in the request sees them stay put.
