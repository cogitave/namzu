---
"@namzu/sdk": minor
---

`bash` accepts an optional `description` (a few words for what the command does). A job started with `run_in_background`, or a command moved to the background, keeps it as `BackgroundJob.description`, and `BackgroundJobRegistryRef.start`, `adopt` and `StartJobParams` take it, so a host can name the job to a person. Nothing changes for a caller that passes none.
