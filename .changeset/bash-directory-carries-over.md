---
'@namzu/sdk': major
---

The built-in `bash` tool now starts each call of a session in the directory the previous call ended in, so `cd packages/app` in one call holds for the next. Variables, functions and aliases still do not carry over. The new directory has to be inside the turn's roots (the working directory, added directories, paths approved for the call); a command that ends elsewhere is put back at the working directory and its result ends with `Shell cwd was reset to <directory>`. A sandboxed command and Windows shells are unchanged, and file tools still resolve relative paths against the working directory. A caller that relied on every call starting at the working directory should use absolute paths or a subshell, `(cd dir && command)`, which leaves the directory alone.

This changes the default from resetting the shell working directory on every call to retaining it within a session.
