---
'@namzu/cli': minor
---

Every session now has a scratch folder from the start, the model is told where it is, and it is told to put what is not part of your request there instead of in your working or home folder.

What changes for you: a model that ran a build in the background, saved a log, wrote a helper script or made a staging folder used to leave `build.log`, `out2/`, `*.bak` and the like in the folder you ran it in. Sessions now say where those go: the session's scratch folder (`<temp>/namzu-<user>/<project>/<session>/scratchpad`), never the working directory or the home folder, with the shared temp folder only when you ask. Files you asked for still go where you said or where the project keeps them. This holds for the terminal, `exec` (including `--json` and `--no-session-persistence`, which had no scratch folder and were told nothing), the ACP host Desktop uses, Pals and scheduled runs; a sub-agent uses its parent's folder, and a sandboxed session keeps its old behaviour. Each background command's whole output is also saved to `<scratch>/jobs/<job id>.log` and the model is given the path in the job results, so it has no reason to redirect output into a file of its own; the model is told a backup copy goes in the scratch folder, not beside the file. This lowers how often a session leaves stray files; in our measurements some runs still wrote a merged copy into the working directory, so it is not a guarantee.

The folder is temporary: the operating system clears it, and Namzu does not remove it when a run ends, so a file in it can still be read after an `exec` run. If your own tooling or a project instruction wanted logs or scripts in the working directory, say so in the request or in your instructions file; "where they said" wins.
