---
"@namzu/cli": patch
---

Stop repeating accepted conversational model switches. A successful solitary
`switch_model` call now ends the turn through the kernel's terminal-tool path,
without another inference to acknowledge it. Repeated requests for the same
accepted target reuse that reservation. Failed requests remain correctable;
mixed tool batches keep their existing result-relay behavior.

Show a compact target row and host-confirmed application instead of duplicating
the pending receipt. Rank missing-model suggestions before limiting them to
eight choices. Let the kernel mount `search_tools` only when deferred tools
exist, avoiding an empty discovery call in ordinary interactive sessions.
