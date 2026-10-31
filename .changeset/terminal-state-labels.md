---
'@namzu/cli': patch
---

Terminal wording and state fixes; nothing to change on upgrade. The model picker labels the providers after "p change provider" as "others". The context meter and `/context` show the smaller of the model window and a configured auto-compact window, the one compaction uses. `/compact` no longer prints a size range that reads the same at both ends. Ctrl+C at a permission question reads "You stopped this" instead of "You declined this", and the counted line of reads above the question settles instead of still saying "Reading". The auto-mode note is a passing footer notice withdrawn when the mode is left. Conversations that share a title in the resume picker show how each ended.
