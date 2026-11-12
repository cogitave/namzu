---
"@namzu/desktop": patch
---

The engine delivery was run end to end on real engines and one defect came out of it. An engine that a description withdraws is now always shown as withdrawn: before, a start that was checking its files while the withdrawal removed its folder could replace that reason with a "file vanished" one, and Settings > Updates would then have said "Could not use engine ..." about something the publisher took back on purpose. Nothing changes for a person yet, because no build carries a signing key.
