---
"@namzu/cli": minor
"@namzu/desktop": minor
---

The Desktop can now start a Pal for a message waiting in its inbox, on the person's click. After an approved `send_pal_message` to a Pal that is not running, the sender's transcript asks "Start *name* now?" and the Pal's own page offers the same (or **Resume** for a paused Pal). **Start** runs the same finite dispatch as `namzu pal dispatch` in the Pal's own host, in the background: the sender's turn is never held, the Pal reads the message in its own conversation under its own permission rules, and its approvals stay in its own tab. A Pal that is already running is only reported, repeated clicks start once, and a missing Pal computer is explained in plain words with **Retry** instead of starting.

The CLI's desktop host gains two methods, `namzu/pals/inbox/status` and `namzu/pals/inbox/start`; an older runtime simply shows no question. Nothing about sending changes: a message still only reaches the inbox, and `send_pal_message` still never starts a Pal itself. If you embed the CLI's authorization, an owner-conversation wake now also accepts a click-evidence object (`operatorWake: { evidence }`) besides `true`; with neither, a wake is still refused.
