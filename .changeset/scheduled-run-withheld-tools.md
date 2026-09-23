---
'@namzu/cli': patch
---

A scheduled run is no longer sent the tools its job can never use, which every model call used to resend. For a browser job that posts once to a site with the `read-only` preset and `--unmatched deny`, a run went from about 106 000 tokens to about 78 000. A tool withheld this way is refused as an unknown tool if the model names it anyway; nothing a job's rules allow is withheld. New `AgentSessionOptions.withheldTools`.
