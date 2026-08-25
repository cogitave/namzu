export { SubprocessComputerUseHost } from './SubprocessComputerUseHost.js'
export type { SubprocessComputerUseHostOptions } from './SubprocessComputerUseHost.js'
export { detectDisplayServer } from './detect/index.js'
export { ComputerUseOutcomeUnknownError } from './errors.js'

/**
 * The three failures a caller has to tell apart.
 *
 * They existed and were thrown from the first release, and none of them was
 * exported — so the only way to distinguish "the binary is not installed" from
 * "the command ran and failed" was to match on `err.message`, which is a
 * sentence this package is free to reword. The README documented them as an
 * error surface the whole time.
 *
 * `AdapterUnavailableError` also carries `missing`, the list of binaries to
 * install, which is the actionable half and was unreachable without the type.
 */
export {
	ActionCapabilityError,
	AdapterUnavailableError,
} from './adapters/types.js'
export { SpawnError } from './util/spawn.js'
export type { SpawnOptions, SpawnResult } from './util/spawn.js'
