---
'@namzu/cli': patch
---

`#note` and `/memory add` no longer write into the repository's
`.namzu/MEMORY.md`. A session refused at start (no provider yet, an unknown
provider, an account to sign in again, plugins that would not load) now saves
the note to this folder's stored memory under the Namzu home, as a working
session does, and keeps the `--type` you gave. Where no stored memory is open,
while the first session is still starting or when Namzu could not open the
folder's saved data, the note is not saved and the terminal says so. If you
used that fallback to add notes for your whole team, edit `.namzu/MEMORY.md`
by hand; it is still read into every prompt.
