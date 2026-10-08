---
"@namzu/cli": minor
---

The Namzu engine's ordinary conversation (terminal and Desktop) can now give a Pal work. It mounts `list_pals` and `send_pal_message` in every such session, and its system prompt names the owner's Pals, separate from sub-agents, only while some exist; a session with no Pals leaves no Pal files. `send_pal_message` always asks the person (in every permission mode and even after "allow all"; `strict` and a session with nobody to ask refuse it) and returns "Sent to *name*'s inbox" as durable acceptance, never delivery or an answer. A paused or removed Pal is refused. The message lands in that Pal's inbox as untrusted context from the owner's conversation; it does not start a stopped Pal, which `namzu pal dispatch` (typed by the owner) still does. `namzu pal inbox` and the Desktop Pal communication view list such a message as `operator-conversation`. External engines and a Pal's own sessions are unchanged.

If you keep an exact list of the ordinary session's tool names (a plugin allowlist test, a snapshot), it now includes `list_pals` and `send_pal_message`; withhold them with `withheldTools` (withholding `send_pal_message` also drops the prompt block).

Desktop: the approval card reads "Message to *name*" with the whole message and a note that it goes to the inbox only, and the action row reads "Messaged *name*" with the hover text "Sent to inbox", including after a reload.
