export { SubprocessComputerUseHost } from './SubprocessComputerUseHost.js'
export type {
	SubprocessComputerUseHostOptions,
	SubprocessComputerUseHostWindowsOptions,
} from './SubprocessComputerUseHost.js'
export type { Win32Backend } from './adapters/win32.js'
export { detectDisplayServer } from './detect/index.js'
export {
	ComputerUseOutcomeUnknownError,
	ComputerUseLockedError,
	ComputerUseStoppedError,
} from './errors.js'
export type { SubprocessComputerUseHostForegroundOptions } from './SubprocessComputerUseHost.js'
export { DEFAULT_TIMING as FOREGROUND_DEFAULT_TIMING } from './foreground/index.js'
export type {
	ForegroundAnswer,
	ForegroundApprover,
	ForegroundSubject,
	LadderTiming,
} from './foreground/index.js'

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
export { PRESENCE_ENV } from './presence/index.js'
export type { Presence, PresenceKind, PresenceMark } from './presence/index.js'
export { A11Y_ENV, A11yError } from './a11y/index.js'
export type {
	A11yAction,
	A11yChangeKind,
	A11yDisplay,
	A11yFingerprint,
	A11yIdentityRequest,
	A11yNode,
	A11yRect,
	A11yResolution,
	A11yResolveRequest,
	A11ySeq,
	A11ySnapshot,
	A11ySnapshotRequest,
	A11yWaitRequest,
	A11yWaitResult,
	A11yWindow,
	AccessibilityBackend,
} from './a11y/index.js'
