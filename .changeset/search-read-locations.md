---
"@namzu/cli": patch
---

Read an already located conversation passage directly through its authenticated
SDK address instead of searching index pages again. This removes an unnecessary
empty read page after late search matches. Source ownership and bytes are checked
again on every read; changed evidence is refused.

The host retains at most 128 locations for ten minutes without retaining their
payloads. Expiry, eviction or restart falls back to the existing bounded lookup
using the same run/sequence/part address. Closing a conversation now releases
both search and read cursors, as well as these temporary locations.
