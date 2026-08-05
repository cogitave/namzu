---
'@namzu/anthropic': patch
---

reasoning effort is dropped only on the models that actually refuse it

With thinking switched off, the driver discarded `xhigh` and `max` on every
model that can switch thinking off. The reasoning was that the pairing is
incoherent anyway — asking a model not to think and then to think as hard as
possible.

Measured against the live API, the rule was too wide. One model family rejects
that combination with *"effort is not supported when thinking is disabled"*;
its siblings accept it and honour the effort. So the blanket rule was silently
discarding a setting the caller asked for and the wire would have applied, on
models where nothing was wrong.

Looking incoherent is not the same as being rejected, and only the wire decides
which. The capability table now carries the levels accepted with thinking off
as a separate set from the levels accepted generally, because on most models
those two sets are identical and on one family they are not.
