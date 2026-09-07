---
"@namzu/cli": patch
---

Remove repeated startup identity from the interactive transcript. The opening
header shows Namzu and its version; current model, reasoning effort and working
directory stay in the footer. Normal startup no longer prints the same connection
again, and the composer supplies the typing hint. Explicit provider/model changes
still confirm their result, reasoning confirmations are shorter, and configuration
warnings, instruction-file disclosure and failures remain visible. Provider/tool
details remain available through `/status` and `/status tools`.

Fix repeated transcript rows after terminal contraction while preserving the
conversation, draft and selected agent. Subagent screens now page tabbed and
Unicode output within the frame; phase and agent panes have distinct boundaries,
and completed status is no longer repeated as activity text.
