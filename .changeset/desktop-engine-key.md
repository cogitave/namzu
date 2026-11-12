---
"@namzu/desktop": minor
---

Namzu Desktop now keeps its engine current by itself. The first public signing key is listed in the app, so an installed app reads a signed description of the newest engine 30 seconds after launch and every four hours, in the background, with no dialog. Before anything runs, the app checks the signature against the listed key, the size and hash of every file, the file list, and a run of the unpacked engine in a clean environment; the engine it fetches starts the next time a project opens, two versions are kept, and the engine inside the installer is the fallback. The app asks only the public release address, sends nothing about you or your computer, and never takes a key from the network.

To turn it off, switch off **Keep the engine up to date** in Settings > Updates: the app then makes no request and runs the engine it was installed with. The first newer engine arrives after the first signed description is published; until then the app asks, is told there is nothing yet, and both Updates and About stay quiet. An app that is not installed (a development run or a preview) never contacts that address unless it is given another feed address explicitly.
