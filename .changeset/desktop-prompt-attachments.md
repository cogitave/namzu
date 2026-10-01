---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Add optional inline user attachments to ACP prompt requests. Hosts opt into delivery with `supportsPromptAttachments: true`; initialization then advertises `promptAttachments: true`. Clients can check this capability before sending bytes, and gateways receive the validated attachment payload alongside the prompt. Stored attachment references are refused across this boundary; inline payloads are limited to eight attachments and 3 MiB of decoded bytes per message.

The CLI opts in and preserves image/document attachments in the actual user message and settled conversation history. Existing plain text requests keep their behavior. The private desktop admits native file picks or dropped/pasted bytes as bounded images and UTF-8 text, keeps draft and queue ownership, and refuses image submission to an older CLI rather than silently dropping it.

New image/document inputs are refused before send when the selected live provider explicitly declares that it cannot receive them. Desktop files remain available for retry with a suitable model. Attachment/settings-only drafts survive a connection rebuild, and queue editing restores captured options together with its text and files. Pre-turn CLI errors retain their actual diagnostic rather than becoming a generic failed turn.

ACP also accepts optional `AcpPromptOptions` with a reasoning effort and tool review mode. Hosts opt in with `supportsPromptOptions: true`, advertised as `promptOptions: true`; unsupported or malformed explicit settings are rejected before a turn starts. The CLI validates reasoning effort against the actual selected runtime's supported menu and applies the captured review mode to that turn.
