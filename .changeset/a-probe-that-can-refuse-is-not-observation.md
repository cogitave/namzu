---
'@namzu/sdk': minor
---

Two new exported interfaces, `ProbeObservation` (`setLogger`, `on`, `onAny`, `dispatch`) and `ProbeEnforcement` (`veto`, `queryVeto`). `ProbeRegistry` implements both and is unchanged, so nothing a host builds or passes changes — this narrows what a *signature* can ask for.

The SDK's own barrel introduced the module as "typed observation over AgentBus + RunEvent stream". That is true of four of its six methods. A registered veto handler denies a tool call, and the executor turns that denial into a failed `tool_result`: enforcement, and the third of the three gates on a tool call, sitting behind a name that said telemetry. The comment is corrected too.

There was also no way to ask for less. `ProbeRegistry` was the only export, so a consumer that wanted to watch had to accept the power to refuse. Inside the SDK the split is now load-bearing: the provider wrapper, the vault wrapper and the run event emitter take `ProbeObservation` and cannot veto; the tool executor takes `ProbeEnforcement`.
