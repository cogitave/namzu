---
'@namzu/cli': patch
---

A finished workflow with a failed agent now reads `3 agents` in its closing line and `2/3 agents` in the `/workflows` list and the detail header, with no failure count beside the counter; the rail row keeps `2/3`, its dot is green for a finished run, red for a failed or stopped run, and red for a running run that has a failed agent, and the phase's agent list shows `· 1 failed` in red after its agent count.
