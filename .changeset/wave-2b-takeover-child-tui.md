---
"@namzu/cli": patch
---

Run configured subagent-start hooks through the real CLI child using the parent's lifecycle manager and the child's own session/turn identity. Keep agent names local to their parent conversation so another conversation cannot take over a child's name.

Bound file-mention reads before allocating file contents: stream line ranges in small chunks, cap per-file and aggregate scanning and attached content, and leave inaccessible or over-budget mentions as text. Growing files cannot extend the initial read ceiling.

Keep ephemeral conversation logs and checkpoints in memory across sends and provider-pause resumes, and propagate that storage choice to delegated children and continuations. A missing transient checkpoint never falls back to a disk transcript.
