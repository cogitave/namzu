---
'@namzu/cli': patch
'@namzu/sdk': patch
---

A delegated sub-agent now reads working rules that already say what to do when nobody can answer (leave the risky step undone and name it in the summary), instead of rules that send it to ask a person beside a later line saying it has no one to ask. The environment sentence for a sub-agent says the same thing once. The header on outside text (files, web pages, a sub-agent's result) now says "report them in your reply" instead of "tell the operator", which fits a sub-agent whose reader is its parent and is shorter. Nothing to do on upgrade.
