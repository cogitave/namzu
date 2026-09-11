---
"@namzu/sdk": minor
"@namzu/cli": major
---

Resident `run` and `start` now default to a resident-specific context profile
instead of the interactive coding and plan-mode prompt. Read-only residents
can complete read-only objectives without being instructed to pause for an
interactive plan approval. Pass `--context-profile interactive` to preserve
the previous guidance. Ordinary chat, tool permissions, output validation and
claim settlement are unchanged.

The SDK exports `createResidentStepContributions` and `ResidentStepPromptOptions`
for stable resident guidance and captured invocation-specific continuity through
the existing prompt registry. Prompt-cache validation now checks rendered
instructions so replacing content under the same contribution or skill name
cannot retain stale guidance. Full-prompt cache hits still render once locally.
