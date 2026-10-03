---
"@namzu/sandbox": minor
---

Add optional exclusive operator control to local Pal computer leases. Hosts can
transfer an idle guest desktop to human mouse/keyboard input while all agent
sandbox and desktop mutation calls are fenced, then return control without
starting a query. Pending work refuses transfer; unknown input or file-write
outcomes require stopping the owned computer. A fresh agent screen capture is
required after returning control. This local container boundary does not hide
same-user guest files or credentials from arbitrary Pal commands.
