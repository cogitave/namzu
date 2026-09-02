---
"@namzu/sdk": patch
---

A background job is its process group, not its shell. A command that backgrounds its real work (`server &`) used to be reported `exited` the moment the shell returned, while the server kept the port; the model was told the job was over and nothing stopped the survivor at session end. The job now stays `running` while any process of its group is alive, ends with the shell's exit code when the group is empty, and `kill` takes the survivors.
