---
'@namzu/cli': patch
---

The token number beside an agent in the rail, and the sum beside a workflow, now says what the agent wrote (its output tokens, as `↓ 6.2k tokens`, the same arrow and meaning as the main turn's row) instead of every prompt it sent again on each request plus what it wrote, which grew with the square of its steps and read as over a million after a few quick steps. Nothing shows until the agent has reported its first usage. The agent's detail screen and the agent list in a workflow's detail spell out the full picture from 110 columns (`wrote 6.2k · sent 1.17M (980.0k cached)`), transcript lines say `N tokens written`, and `/workflows` says `N tokens in all` because the journal keeps only the cumulative figure. The `agent_task_list` tool output keeps `tokens` as it was (cumulative) and gains `outputTokens`; nothing is removed or changes meaning, so a caller that reads `tokens` is unaffected, and one that wants what the agent wrote reads `outputTokens`.
