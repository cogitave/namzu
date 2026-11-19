---
'@namzu/cli': minor
---

Adds the extension platform: `namzu extension` (`add`, `list`, `status`, `notice`, `license`, `enable`, `disable`, `remove`, `grant`, `revoke`, `key`, `run`, `validate`) and the `namzu/extensions/*` methods and `namzu/extensions/state` notification for Desktop.

An extension is a separate signed program with a manifest that lists every permission with a purpose in plain words, the data it makes and how long it keeps it; `extension add` refuses a permission without a purpose, and the host refuses at run time any query, kind, column, permission or setting the manifest did not declare. The notice is acknowledged once per person and extension and is asked again only when the scope widens or the notice version changes; an update that asks for more waits, staged, while the old version keeps running. While an extension runs there is always a mark in the terminal (a row under the composer) and in Desktop.

Nothing changes for anyone who adds no extension: this build trusts no publisher key yet, so no package can be added to it (a developer key is accepted only with both `NAMZU_EXTENSION_DEV=1` and `NAMZU_EXTENSION_TEST_PUBLIC_KEY`). The interactive terminal and Desktop's engine run what is enabled while they are open.
