---
"@namzu/cli": minor
---

Background jobs that work the way the tool description promised. A session now owns a job registry: `bash` with `run_in_background` starts a job that outlives the turn, the model is told on its next tool result when a job ends, and the transcript shows a `⚙` row whether or not a turn is running; a job that ends between turns is reported to the model at the start of the next one. `/jobs` lists them. Jobs stop when the session closes. Under a sandbox no job can start, as before — the registry runs on the host and the kernel refuses to seat it beside a sandbox.
