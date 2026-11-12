---
"@namzu/desktop": patch
---

Repairs to the engine updates after a final review on real engines. A newer engine that could not be downloaded or stored (a full disk, a connection that cuts the download) is no longer shown as "up to date" in Settings > Updates: the row says it could not check for a newer engine, and the same version is not downloaded again at every check (it waits 24 hours, and a restart tries once more). The signed description, its signature file and the engine's file lists are refused when they start with a byte-order mark, the same as the publishing side. A give-up is logged once per engine. "Use this app's own engine" is no longer offered while the setting is off. Nothing changes for a person yet, because no build carries a signing key.
