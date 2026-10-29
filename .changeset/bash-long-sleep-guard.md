---
'@namzu/sdk': major
---

The built-in `bash` tool now refuses a call that opens with `sleep` for 25 seconds or more (alone, or as the first part of a chain) when the host has background jobs, and tells the model to use `monitor` with an until-loop, or `run_in_background` with `wait_for_job`. Shorter sleeps, later sleeps in a chain, background runs, and hosts without background jobs are unchanged. A caller that needs a long fixed wait can run it with `run_in_background`.

This changes the default for a leading sleep of at least 25 seconds from running it to refusing it when background jobs are available. Move the wait to the background job tools, or split the sleep into a supervised job.
