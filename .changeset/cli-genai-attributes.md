---
'@namzu/cli': minor
---

When telemetry export is on, spans now carry the OpenTelemetry GenAI convention names (version 1.41.1) beside the existing ones. To leave them off, for a backend that bills by attribute, set `NAMZU_TELEMETRY_GENAI=0` (or `false`, `no`, `off`) with the export. Nothing existing is renamed or removed.
