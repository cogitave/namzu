---
'@namzu/sdk': patch
---

Correct advisory trigger inputs. Context-pressure triggers now use the same current-context measurement and model-window resolution as compaction, including tool results appended after the provider's last prompt measurement. Cumulative token spending no longer masquerades as context fullness. Error triggers inspect canonical failure flags from the current tool batch, retain errors beside successful sibling calls, and stop reacting to failures from older batches or successful output that merely begins with `Error:`.
