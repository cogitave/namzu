---
"@namzu/sdk": minor
---

Allow hosts to lower the read allowance for an individual resident-history or
run-evidence search/read operation with `maxReadBytes`. Resident history accepts
1 byte through 8 MiB; run evidence accepts 1–8 MiB and cannot exceed its source's
configured ceiling. The option also reaches captured live-boundary text readers.
Existing defaults and cursor/address identity remain unchanged, so a continuation
can use another allowance while preserving its scope and source validation.

Custom source backends must honor the new option when their caller supplies it.
An insufficient allowance can stop traversal or refuse a read; it does not mean
the requested evidence is absent. These low-level controls do not yet impose a
combined budget on the resident tool-evidence wrapper.
