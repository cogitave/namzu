---
'@namzu/cli': minor
---

A session now tells the model where to put what it creates: temporary work in the scratchpad, app data and config in the platform's standard folders, containers in a named project folder, and a checklist for anything that keeps running. It must not create or delete a top-level entry in your home folder or the filesystem root without asking, must say the full path of every folder it creates, and ends a setup with a short receipt. The terminal UI also shows one quiet line at start when the working folder is your home folder or the filesystem root. Nothing breaks and no permission changes; the prompt gains one cached section, so a custom prompt snapshot of the full text will differ.
