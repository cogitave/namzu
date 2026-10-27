---
'@namzu/sdk': major
---

A failing `bash` result no longer ends with the line "NOTE: N credential-shaped environment variables were removed ..."; its `output` is only what the command printed, and the count is in `data.withheldEnv`. The kernel now tells the model in a framed user-role notice of its own after the tool batch, once, and again only when the count changes. If your host parsed that line out of `output`, read `result.data.withheldEnv` instead; `describeWithheldEnv` now returns the notice sentence without the "NOTE:" prefix.
