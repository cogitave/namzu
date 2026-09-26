---
"@namzu/cli": minor
"@namzu/sdk": minor
---

Scheduled script proposals now explain the permission set they actually need, including why `read-only` blocks every script and why a home-directory working folder is refused. The CLI shows a compact, scrollable confirmation for model proposals and `/schedule` confirmations, with the exact source available for review. It labels pure-script permissions accurately and explains a blanket `bash` denial without suggesting a script rewrite.

New `notifyOnFinish` on the schedule tool and `--notify-finished true|false` on the CLI let a polling job suppress Namzu's generic success notice while keeping failure notices. The default remains `true`; existing jobs keep their behavior until changed.
