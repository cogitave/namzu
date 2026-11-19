---
'@namzu/cli': minor
---

The Desktop host takes a permission mode change for a reply that is already running. A new `namzu/session/set-permission-mode` request (`sessionId`, `mode`) makes the running turn decide its next call under the new mode and records the change in the conversation's log; it is refused with the reason when the settings close the mode (Allow bypass permissions mode off, `permissions.disableBypassMode`, no model for Auto). With no reply running it only checks the mode. Nothing changes for a client that does not send it; the host lists it in `initialize` as part of the `livePermissionMode` group.
