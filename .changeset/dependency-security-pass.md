---
'@namzu/telemetry': major
'@namzu/anthropic': patch
'@namzu/bedrock': patch
---

Lift the dependency floor to versions without published advisories

Eighty-two open advisories collapsed to a handful of real decisions, because most of them were the same package reached through one path.

The telemetry exporters carried a serialization library with twenty-four advisories against it, two of them critical. The exporters move from the 0.57 line to 0.221, and the stable packages beside them from 1.x to 2.x — a major bump for this package, since a consumer pinning the older peers must move with it.

The two vendor driver SDKs move to their current releases, closing the advisories that came with them.

The test runner accounted for fourteen critical advisories on its own. It is a development dependency and never reaches a published artifact, but it runs in CI against the repository's own contents, so it moves to the first patched release rather than being waved through as out-of-scope.
