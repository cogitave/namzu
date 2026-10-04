---
"@namzu/sdk": minor
---

Add `createHarnessSession` and host-composed external engine contracts. External sessions record an immutable engine/profile/native-session/cwd binding, authored prompts before dispatch, native item identities and exact review decisions under the existing session writer lease. Admission is required before native execution or approval; interrupted connections require matching native history and never automatically resend prompts. Existing Namzu query, provider and tool execution APIs and defaults are unchanged. New optional `harness` payloads use the existing session record kinds.

New external-bound journals cannot be continued through kernel `query`, `resumeSession` or `TurnRecorder.open`; use their recorded harness adapter or a separate Namzu session. Reading their owned history remains available.
