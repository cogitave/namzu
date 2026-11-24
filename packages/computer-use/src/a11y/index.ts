export { WindowsA11yHost } from './a11y.js'
export type { A11yProcess, WindowsA11yOptions } from './a11y.js'
export { A11Y_BOOTSTRAP, A11Y_HELPER_SCRIPT, a11yScriptLine } from './a11y-script.js'
export { A11Y_ENV, a11yDisabledByEnv, createWindowsA11yHost } from './windows.js'
export type { WindowsA11yFactoryOptions } from './windows.js'
export { A11yError } from './interface.js'
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
} from './interface.js'
export { MacA11yHost, cgWindowId, createMacA11yHost } from './macos.js'
export type {
	MacA11yFactoryOptions,
	MacA11yHandle,
	MacActResult,
	MacCapture,
	MacControlAction,
	MacNode,
	MacPermissions,
	MacSelfCheck,
	MacTree,
	MacTreeRequest,
} from './macos.js'
export {
	MAC_HELPER_BUNDLE_ID,
	MAC_HELPER_NAME,
	ensureMacHelper,
	macHelperPaths,
	macHelperSourceHash,
} from './macos-helper.js'
export type { MacHelperPaths } from './macos-helper.js'
export {
	ensureSigningIdentity,
	macSigningDir,
	parseFingerprint,
} from './macos-signing.js'
export type { MacSigningIdentity } from './macos-signing.js'
