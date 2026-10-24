---
'@namzu/cli': minor
---

Ctrl+D on an empty composer now arms exit like Ctrl+C: the first press shows a dim `Press Ctrl-D again to exit` in the footer for 800 ms and a second press within that window quits; with text in the composer Ctrl+D still deletes forward. The Ctrl+C reminder is now the same footer hint instead of a line left in the transcript.

The Working row hides its `( … )` figures until there are tokens, thinking, a compaction, running agents or more than 16 s, and no longer repeats `esc to interrupt` (the footer keeps it, except under a dialog that owns Esc). Durations everywhere read `12s`, `1m 23s`, `2h 3m 4s` (whole seconds; sub-ten-second figures no longer show a decimal, so anything that matched `3.2s` must match `3s`). After 10 s without a token the label fades toward red. The approval-required terminal notice and notification hook now wait 6 s without a key press and are dropped if the dialog is answered first. `Worked for` no longer counts time spent waiting for a permission or question answer.
