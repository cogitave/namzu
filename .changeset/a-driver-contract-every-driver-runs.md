---
'@namzu/sdk': minor
---

New `defineProviderDriverConformance` at `@namzu/sdk/testing`: the `LLMProvider` contract as a suite a driver package runs against itself. All seven in-tree drivers now run it, and a test fails if an eighth package appears without one.

Seven packages implemented `LLMProvider` and there was nowhere to write a rule binding all of them. Each carried a hand-written error-taxonomy test covering the same ground differently, and every provider finding in the recent audit was a behaviour present in exactly one driver and absent from the other six — which is what a contract living in seven copies of a test produces.

It takes `describe`/`it`/`expect` as arguments, so the SDK gains no test dependency from publishing it and a host on another runner can still run it. That also buys the property separating a contract from a list of opinions: a caller can pass *recording* functions and run the whole suite as ordinary code, which is how a deliberately wrong driver is shown to fail it.

Seeded only with rules that pass for every driver today. A suite that ships red is a suite somebody switches off in its first week; the four known gaps each add a rule here in the commit that closes them.

**`@namzu/sdk/testing` now resolves to a barrel** rather than straight at the checkpoint-store file. Every existing import keeps working — `defineCheckpointStoreConformance` and its types are re-exported unchanged, and a test fails if the barrel drops them.
