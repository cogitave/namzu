---
'@namzu/cli': patch
---

On Windows, opening a Pal or a conversation no longer starts three Windows processes (`whoami`, `icacls`, `icacls /save`) every time it checks that a state folder is private. The check still runs the first time this process meets a folder, and it runs again when the path names a different folder than before (another device, file id or creation time), so a folder replaced under the same name is re-proved. What changed is that a folder this process already proved private is not re-proved while it is still the same folder, so an access-list edit made to that same folder while Namzu runs is no longer noticed until the next start. The signed-in account's id is also asked for once per process. Nothing changes on other systems. On a Windows machine with antivirus scanning, this removes seconds from opening a Pal.
