---
"@namzu/sdk": minor
"@namzu/cli": major
---

Resident `run` and `start` now default to `--learning-disclosure on-demand` in the resident context profile. Previously all accepted learned skill bodies were included automatically; now the model sees their descriptions and can read relevant guidance with `read_resident_skill`. To retain automatic inclusion, pass `--learning-disclosure eager`. The interactive context profile and ordinary chat retain their existing behavior. Stored learning is unchanged.

The SDK adds `createResidentStepContext`, which returns prompt contributions and a read-only skill tool bound by the host to one admitted run. Source dependencies are checked when instructions are read and before subsequent requests. Existing `createResidentStepContributions` callers retain eager disclosure.
