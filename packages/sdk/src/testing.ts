/**
 * Contracts a host or a driver package runs against its own implementation.
 *
 * Published at `@namzu/sdk/testing` — a separate subpath rather than the
 * root, so importing a conformance suite is a deliberate act and the main
 * entry stays free of anything shaped like a test.
 *
 * Every suite here takes its `describe`/`it`/`expect` as arguments. That is
 * what lets this ship without the SDK gaining a test dependency, and it
 * buys the property that separates a contract from decoration: a caller
 * can pass RECORDING functions and run the whole suite as ordinary code,
 * which is how each one is shown to fail a deliberately wrong
 * implementation.
 *
 * This barrel exists because the subpath used to point straight at the
 * checkpoint-store file. A second suite would have had to either move that
 * file's export or claim a subpath of its own, and neither is a decision a
 * consumer should absorb.
 */

export {
	CHECKPOINT_STORE_CONTRACT_VERSION,
	defineCheckpointStoreConformance,
} from './store/run/conformance.js'
export type {
	CheckpointStoreCapabilities,
	CheckpointStoreConformanceOptions,
	CheckpointStoreHandle,
	ConformanceAssertion,
	ConformanceDescribe,
	ConformanceExpect,
	ConformanceIt,
	MakeCheckpointStore,
} from './store/run/conformance.js'

export {
	PROVIDER_DRIVER_CONTRACT_VERSION,
	defineProviderDriverConformance,
} from './provider/conformance.js'
export type { ProviderDriverConformanceOptions } from './provider/conformance.js'
