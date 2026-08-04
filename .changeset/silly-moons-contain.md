---
'@namzu/sdk': patch
---

The plugin subsystem contains its paths. It had none, and it is the part of
this SDK that loads third-party code.

**A manifest could name any file on disk.** `PluginLifecycleManager` built its
import path with `join(plugin.rootDir, toolPath)`, and `toolPath` comes out of
the plugin's own manifest — a file the plugin author writes. A manifest reading
`"tools": ["../../../../somewhere/evil.js"]` left the plugin directory entirely
and was imported, which is to say executed, in-process. The same held for
`hooks`. Both now resolve through `resolveWithinReal`, so a path that escapes
the plugin root is refused before anything is imported.

**Discovery followed symlinks.** `discoverPlugins` used `stat`, which reports
on a link's *target*, so a symlinked entry pointing anywhere on disk was
admitted as a plugin directory and its manifest read from there — the directory
listed was not the directory loaded (CWE-59). It now uses `lstat` and refuses a
link with a warning naming the path.

Found by comparing the plugin loader against `@namzu/sdk`'s scanner, which
was written this week with both protections. The subsystem that had them was
the one loading code the repo's own reviewers wrote; the one without them was
the one loading code from a home directory those reviewers never see.

If you ship a plugin whose manifest points outside its own directory, it now
fails at enable with a message naming the path. Move the file inside the plugin.
