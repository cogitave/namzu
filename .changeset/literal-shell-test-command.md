---
"@namzu/sdk": patch
---

Recognize a source-exact bare `[` POSIX test command as a literal program
instead of falsely classifying it as a glob-expanded command. This removes
unnecessary unknown-program approval prompts for ordinary shell predicates and
copy loops in automatically approved Pal guest work. Real bracket patterns,
runtime-produced program names, opaque shell constructs and dangerous-command
denials retain their existing review/refusal behavior.
