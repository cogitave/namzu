---
"@namzu/sdk": patch
---

Stop foreground host shell descendants on cancellation, timeout and output overflow by terminating the shell's owned POSIX process group. Previously the shell wrapper could exit while its child commands kept running. Preserve timeout and command-failure output and escalate termination after a three-second grace period.

Bound cancellation even when a descendant creates a separate session and retains inherited output pipes. Such a process has escaped the owned group and is not guaranteed to stop; the host shell runner is not a containment boundary.

Report clipped host output with stream truncation flags and a notice, including when the cap is reached during timeout cleanup. Keep complete UTF-8 characters at the output cap.
