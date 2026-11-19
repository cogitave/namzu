---
'@namzu/cli': patch
---

The sentences `namzu acp` sends when a request is refused are plain English ("Namzu has no AI service set up on this computer yet. Add a key or sign in to one in Settings, then send again." instead of "No LLM provider is available on this machine: set a credential in the environment…"), and eight of them carry a stable code in the error's `data.code` (`no-provider`, `connection-closed`, `folder-not-trusted`, `conversation-in-other-folder`, `conversation-opening`, `message-not-sent`, `too-many-messages`, `permission-mode-needed`). A program that matched the old sentences should match the code instead.
