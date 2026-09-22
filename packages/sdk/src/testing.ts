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
 * A custom session log (a database, an object store) is proved against
 * the session-log suite; a provider driver against the driver suite.
 */

export {
	SESSION_LOG_CONTRACT_VERSION,
	defineSessionLogConformance,
} from './store/session-log/conformance.js'
export type {
	MakeSessionLog,
	SessionLogAssertion,
	SessionLogConformanceOptions,
	SessionLogHandle,
	SessionLogTamper,
} from './store/session-log/conformance.js'

export {
	PROVIDER_DRIVER_CONTRACT_VERSION,
	defineProviderDriverConformance,
} from './provider/conformance.js'
export type { ProviderDriverConformanceOptions } from './provider/conformance.js'

export { fixtureId } from './test-support/ids.js'
