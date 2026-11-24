---
"@namzu/computer-use": minor
---

Adds the TypeScript side of `namzu-win/1`, the line protocol of the native Windows helper that is replacing the PowerShell scripts behind Windows computer use: `encodeRequest`, `decodeReply`, `formatRef`, `parseRef` and `nameHash`, in `src/native/` (not exported from the package yet). Nothing starts the helper yet, so no existing behaviour changes and nothing needs doing on upgrade; the new backend is opt-in until delivery lands.
