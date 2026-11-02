---
"@namzu/cli": minor
---

The model now knows what is still running without being asked to look. Every model request of every turn carries a note listing the conversation's background jobs, monitors, background agents and workflow runs, one line each, saying whether it is progressing, waiting (and on what), stalled or dead, and how long since it last moved; it is rebuilt for each request, so it is present in a new turn and after a compaction and is not stored in the history.

`agent_task_list` returns the same lines (`outstanding`) and, for each workflow run, its phase, agent counts, recent `log()` lines, previews of what finished agents answered (marked as data) and elapsed time, with no estimate of the end; `run_id` reads one run. Task rows gain `elapsed_ms` and `last_progress_ms_ago`. `wait_for_task` now stops waiting after two minutes without activity from the task and says it went quiet; the task keeps running. The workflow completion message carries an `ended_at` time. The workflow launch receipt allows one status read when the person asks how it is going. A caller that parsed `agent_task_list` output keeps working: fields were added, none removed.
