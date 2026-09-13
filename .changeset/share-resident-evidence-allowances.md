---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Allow a host to bound a resident tool-evidence operation across history,
invocation resolution and archive reads with `maxReadBytes`. Configure the
source's `resolutionReadBytes` with a host-enforced document-read ceiling;
bounded calls refuse to proceed without that declaration. Their `chargedBytes`
includes the declared resolution allowance, and a failed source search without
a byte receipt conservatively consumes the remainder. Calls without the new
option retain their separate existing limits.

The CLI declares the existing size bounds of its two attempt receipts, making
its source usable by bounded host retrieval. This does not enable automatic
resident recall yet. Returned pages must match their resolved invocation's
tenant/project/Session/run identity, and cancelled reads cannot expose a late
backend result. Custom sources must honor the read limits they accept.
