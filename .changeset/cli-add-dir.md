---
"@namzu/cli": minor
---

`/add-dir <path>` lets the file tools reach another directory for the rest of the session — by absolute path, bound read-write into the sandbox from the next turn — and `/add-dir` alone lists them. `--add-dir <path>` (repeatable) does it for one launch, and `additionalDirectories` in the config file for every session. The model is told which directories it may reach in the environment prompt, and `/status` lists them under where it may write.
