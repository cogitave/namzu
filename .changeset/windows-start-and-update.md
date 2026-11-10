---
'@namzu/cli': patch
---

Faster start on Windows, and no frozen terminal while Namzu updates itself.

Provider discovery no longer proves a credential directory private for a saved-key file that does not exist, and it reads the saved API keys once instead of once per provider. Each of those proofs is two `icacls` processes run synchronously, so on Windows the "discovering providers…" step took about two seconds and held the event loop long enough that a running Ollama could be missed. `namzu providers-json` on Windows went from about 2,050 ms to about 1,030 ms in a measurement on one machine, and now reports a running Ollama. A credential file that exists is still proved private, directory first, before it is opened.

The automatic update keeps its copy of the installed version, and puts it back when needed, asynchronously, so the terminal keeps answering while those files are copied. `backupPackage` and `restorePackage` in the CLI's update module are now asynchronous; they are internal to the CLI.
