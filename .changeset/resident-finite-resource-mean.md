---
"@namzu/sdk": patch
---

Keep resident selection's mean resource cost finite when valid large observations would overflow an intermediate sum. Candidate explanations retain their numeric cost and score when serialized, and very small nonzero observations are not all discarded by dividing each cost prematurely. Selection remains opt-in; policy values and resource units are unchanged.
