---
"@namzu/cli": major
---

Make `/memory show` and `/memory list` inspect curated memory instead of saving the words `show` or `list`. `/memory add <text>` explicitly saves a note; empty `add` displays usage. To save a literal reserved word, use `/memory add show`, `/memory add list` or `/memory add add`. A leading `--user` keeps user scope; ordinary free-text notes remain supported. The inspection and add keywords are case-insensitive. Memory reports now show labelled sections, full file paths and bounded previews, without printing instructions intended for the model.

Permission menus now use plain preset labels, place advanced modes and rules under More options, and show the effective session approval state. Settings use named controls and reflect a previous approval of all tools. The approval prompt explicitly labels its session-wide all-tools choice. Underlying permission rules, mode shortcuts and sandbox restrictions are unchanged.
