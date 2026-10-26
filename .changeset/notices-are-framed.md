---
'@namzu/sdk': minor
---

The notices the kernel appends to a tool result are now inside a `<namzu-notice kind="operator-message|job|monitor">` frame that says whose words they are: a message the operator typed while the tool ran is called their own and not the tool's output, and a background job's or monitor's notice is called automated and not new operator input. The labels `[Message from the operator, received while this tool was running]`, `[Background job update]` and `[Monitor update]` are unchanged. The tag is escaped (`&lt;namzu-notice`) in every tool result built with `createToolMessage` and in project instruction files, so a command's output or a file cannot forge a frame; new exports `escapeNoticeFrame`, `frameNotice` and `NOTICE_TAG` from the message types. A host that matched a notice by its exact text should match the label line instead; `readSteeringNote` still reads the operator's text back.
