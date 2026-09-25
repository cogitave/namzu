---
'@namzu/sdk': major
'@namzu/cli': patch
---

The SDK now accepts application-defined agent type strings and provides `QueryAgent` as the generic managed query adapter. `defineAgent` gives its `run` callback a required fourth `AbortSignal` parameter and creates fresh instances for delegated turns. Code that invokes a `DefineAgentOptions.run` callback directly must supply that fourth argument; existing three-argument callback implementations remain assignable. `ReactiveAgent` and the supervisor, pipeline and router exports remain available as deprecated compatibility names. CLI delegated turns use a CLI-owned `NamzuCliAgent` while keeping their existing configuration behavior.
