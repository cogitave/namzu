---
"@namzu/sdk": minor
---

`HostCommandDescriptor` gains two optional fields, `modelRun` (`'run' | 'confirm' | 'never'`) and `modelRunReads`, and the type `HostCommandModelRun` is exported. A host that lets the model run commands for the person reads them: `run` goes ahead, `confirm` asks the person first, `never` is refused. A command that declares nothing is `never`, so nothing changes for existing commands. The kernel's `goal` command is `confirm` with `/goal` and `/goal status` as read forms; `skills` and `agents` are `run`.
