---
"@namzu/cli": major
---

**Sessions run the kernel's `salience` compaction by default.** The context is held near half the model's window by scoring every message and clearing what the run has stopped using, before any summary; `/context` shows what it did. The previous behaviour is one line in the config file: `compaction: { strategy: structured }`.
