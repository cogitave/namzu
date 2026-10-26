---
'@namzu/sdk': minor
---

The notices the kernel sends the model are framed: a message the operator typed while a tool ran, a background job's exit and a monitor's events each sit inside a `<namzu-notice-<marker> kind="operator-message|job|monitor">` frame that says whose words they are. The operator's message is called theirs, and a job's or monitor's notice is called automated and not operator input. The marker is random for each frame and the frame says only that exact closing tag ends it, so text inside cannot close it. The labels `[Background job update]` and `[Monitor update]` are unchanged. The tag prefix is escaped (`&lt;namzu-notice`) in every tool result built with `createToolMessage` and in project instruction files, so a command's output or a file cannot forge a frame; new exports `escapeNoticeFrame`, `frameNotice` and `NOTICE_TAG` from the message types. `readSteeringNote` reads the operator's text back from a frame.
