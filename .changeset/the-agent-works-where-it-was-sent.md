---
'@namzu/cli': patch
---

the agent works in the directory `--cwd` names, instead of searching this one and reporting nothing

`--cwd` reached the session store and the skill search and stopped there. The
run itself was started with the process's own directory, so:

```
namzu run-stream --cwd /projects/foo "read notes.txt and edit it"
```

made the model call `glob`, which answered

```
No files found matching pattern "**/notes.txt" in /wherever/namzu/was/launched
```

`notes.txt` exists. The agent looked somewhere else and reported the file
missing, which is the worst available way to be wrong about a path — a user
reads it as "that file is not there" rather than "I searched the wrong tree".
Nothing was edited and the run still exited 0.

The resolved directory is now what the whole session is built on: every
filesystem tool, the sub-agent runtime, the task store and the memory store. It
is threaded in as an argument (`createAgentSession(prefs, detected, { cwd })`)
rather than read from `process.cwd()` at each of those four points, which is how
the value went missing at exactly one of them.

`--cwd` is also resolved to an absolute path and checked before the run starts.
A path that is not there is refused instead of falling back to this directory —
the silent fallback is what turned a typo into a run that searched somewhere
else and found nothing.

`namzu skills-json --cwd <path>` reads that directory's project skills too. It
was the last command still ignoring the flag, so a host could be offered a skill
for one checkout and then find that a turn in that same checkout could not load
it.

**Why no test caught it.** No test ran a file tool against a directory that was
not the process's own, so the two were the same string in every assertion. The
regression test executes the real `glob` builtin against a temporary directory
and asserts it finds a file that exists nowhere else.
