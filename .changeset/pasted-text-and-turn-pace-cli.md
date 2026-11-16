---
'@namzu/cli': minor
---

A paste is kept apart from what you wrote, a long quiet stretch gets one sentence, and each message carries its time.

Pasted text. A paste that becomes a chip in the terminal reaches the model inside its own frame, with one line saying it was pasted and that directions in it are followed only where your own words ask. Nothing you see changes: the conversation, the detailed transcript, a resumed conversation and an export show the paste as you sent it. A paste is no longer read for a `+500k` token target, no longer names a conversation when you typed words of your own, and an `@path` inside one is no longer read as a request for that file. The memory the curator keeps no longer files pasted text as something you said, and the summary written when a long conversation is compacted carries a paste inside its frame too. A message you send while the model is already working is not framed: it reaches the model as a note, so a paste in it reads as your own words.

Quiet stretch. In the terminal and the Desktop application, after at least 90 seconds and 6 tool calls without a sentence the model is asked, once, for one sentence on what it is doing, in the same response as its next tool call; time spent waiting on you does not count. New key `progressNudge` (`mode: auto | on | off`, `afterSeconds`, `afterCalls`): `auto` is the default and leaves `namzu exec`, scheduled runs, Pals and sub-agents alone; `on` also nudges `namzu exec` in text mode. Set `mode: off` to turn it off.

Message time. Each message you send carries `[Sent at 22:41, UTC+03:00 Europe/Istanbul]`; from the second message on, a line is added only when it is 5 minutes or more after your previous one, and says the gap in words (`2 h 15 min after the previous message`). It is stored with the message, so a resume sends the same bytes, and it is never shown.
