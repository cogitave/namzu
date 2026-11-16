---
'@namzu/sdk': minor
---

A session's scratch folder is made when its first turn starts, not when a tool call first names it, and a background job's output is saved to a file. Nothing is removed and no export changes name.

What changes for a host: `query` makes the folder (owner-only, under the private temporary folder) before the first request, and a delegated turn uses its parent's folder instead of one of its own. New optional `QueryParams.scratchpadDirectory` names the folder for a host that keeps no session state on disk (without `paths` there was none); a path outside the private temporary folder is refused and the turn runs without one. Every background job (`bash` with `run_in_background`, a foreground command moved to the background, `monitor`) now also writes its whole output to `<scratch>/jobs/<job id>.log`; `BackgroundJob.outputFile`, the `outputFile` in the tool results' `data`, and the `bash`, `job` and `wait_for_job` result text carry the path. `bindOwner` takes an optional `outputDirectory` and `StartJobParams` an optional `outputDirectory`; a host that passes neither sees no change. The `bash` tool description now tells the model that long and background output is saved for it. The working rules say a reproduction script stays in the scratch folder unless it becomes a test, and no longer ask the model to report a throwaway file.

If a test of yours counted the folders under the temporary root after a turn, it now sees the scratch folder even when no tool ran.
