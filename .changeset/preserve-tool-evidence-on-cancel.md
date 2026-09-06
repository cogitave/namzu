---
"@namzu/sdk": patch
"@namzu/cli": patch
---

Keep completed tool receipts when cancellation interrupts a post-tool hook, withholding unreviewed output and failure-log details while preserving execution status. Cancellation stops retry scheduling, and calls cancelled before execution receive an explicit not-started result. Provider cancellation no longer waits on a blocked iterator, and unknown token spend remains reserved even when the idle timeout is disabled.

Shell commands now report incremental progress on the host as well as in a sandbox. Sandbox timeouts preserve partial stdout and stderr; clipped output no longer recommends blindly replaying a command.

The CLI retains long first lines and output beyond 200 lines for Ctrl+O and raw view. Long lines receive bounded, expandable previews. The composer header fits very narrow terminals, and animation regressions cover a complete border lap and cleanup.
