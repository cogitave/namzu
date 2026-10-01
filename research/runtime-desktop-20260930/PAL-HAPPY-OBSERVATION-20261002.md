# Happy reference inspection, 2026-10-02

## Evidence boundaries

The operator authorized inspection of the signed-in Windows ChatGPT client.
The existing Happy conversation, profile, customization dialog, computer viewer,
activity view and existing activity task were inspected through native window
capture and UI Automation. No message, call, task, channel connection, profile
save, pause, reboot, deletion or computer takeover was performed.

Raw captures contain private conversation content and remain outside Git in the
operator's temporary audit directory. The observations below summarize product
behavior without copying that conversation. The computer tab opened for this
inspection was closed; the original chat was restored, and the profile/activity
views were closed. Window state alone is not evidence of the service's internal
sandbox, networking or message-delivery implementation.

## Observed screens

| View | Observed behavior | Namzu implication |
| --- | --- | --- |
| Existing Happy chat | Rounded assistant/user bubbles, shared composer, identity at the top, separate call affordance | Reuse the normal transcript/composer and keep profile identity separate from model choice. |
| Profile | Name/avatar/status, computer list, recent activity, outputs and existing contact affordances | Show actual availability and owned activity/outputs; empty output is explicit. |
| Computer list | The Dot's computer and the operator's connected device are separate rows | A Pal control folder cannot represent its computer; host-device access requires a separate contract. |
| Customize | Name, visual customization, preview and Save in a modal | The individual creation/customization step precedes Team views; inspecting does not save changes. |
| Dot actions | Rename, Pause, Reboot and Delete are distinct actions | Pause, stop/restart and deletion must not be conflated. Implement only actions with a verified runtime contract. |
| Live computer | A separate computer tab shows an actual browser desktop; the chat floats beside it; ownership text says the Dot has control and offers Take over | Input control needs explicit arbitration. Namzu's initial capture view is read-only; it must not claim interactive takeover. |
| Activity view | Global activity replaces the sidebar catalogue, with priority and date groups | Global notifications are distinct from an individual Pal's event subscription and inbox. |
| Existing activity task | Opens an ordinary task conversation; a message is attributed to Happy | A Pal identity can initiate a separate task route. Attribution is distinct from sharing a private main transcript. |

Opening the computer view displayed a running graphical desktop/browser and its
control affordance. No command or input was sent into that computer. Existing
assistant statements about terminal/session access were not used as capability
proof: those are model outputs, not tool or transport contracts.

## Channel conclusions from official documentation

The [official channel guide](https://learn.chatgpt.com/docs/dots/channels)
describes one Dot identity across contact methods, while channel conversations
remain distinct and context sharing requires permission. Adding a channel does
not itself subscribe the Dot to all activity. The [control guide](https://learn.chatgpt.com/docs/dots/controls)
distinguishes activity review, permissions and stopping work.

The signed-in Happy view exposed an existing contact affordance, but this audit
did not create or test Slack/Teams transport. Those transports require their
own installation, authentication and destination grants. A provider's marketing
or a visible button does not prove Namzu integration.

## Current Namzu comparison

The new SDK/CLI/desktop MVP shares saved Pal identity, immutable revisions,
conversation ownership, a mandatory guest computer and admission controls. The
desktop context lists owned conversations and current change receipts. It does
not yet claim a resident autonomous loop, human takeover, arbitrary host-terminal
attachment, external channels or Pal Team organization. Durable communication
and action subscription are specified separately in the
[communication research](PAL-COMMUNICATION-CHANNELS-20261002.md).
