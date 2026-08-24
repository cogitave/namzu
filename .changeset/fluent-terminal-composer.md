---
'@namzu/cli': minor
---

Make the interactive composer distinguish active-turn steering from queued
follow-ups: Return steers at the SDK's next safe boundary while Tab queues the
next turn, preserving attachments and durable ordering. Add Alt+V clipboard
images and Ctrl+W word deletion, widen slash-command descriptions, keep recent
transcript rows next to the composer, and replace the clean-exit diagnostic dump
with a concise conversation `/resume` handoff.
