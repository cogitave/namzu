---
'@namzu/cli': minor
---

Add opt-in, content-free terminal notifications to the interactive UI.

Configure `tui.notifications` as `true` for both supported moments or as a list
containing `turn-settled`, `approval-required`, or both. Notifications remain
off when the setting is absent. `tui.notificationMethod` selects `osc9` (the
default) or `bel`.

Approval is signalled only when the prompt actually opens. Turn settlement is
signalled only after immediately queued work is exhausted; manual interruption
and an abandoned turn from a resumed conversation do not produce late or
duplicate notices. Fixed notification text carries no conversation or tool
content, and no host command is started.

The terminal protocols do not acknowledge display or sound. A successful write
therefore means only that the request was sent and may still be ignored by the
terminal or an intermediate session.
