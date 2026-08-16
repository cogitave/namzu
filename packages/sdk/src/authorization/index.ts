// This barrel is authorization: a rule engine that decides, BEFORE a tool
// runs, whether the call is permitted. It is not verification, and the
// module-invariant registry that used to sit beside it here moved to
// `src/invariants/` for that reason — see the note on the move in that
// file. Keeping the two in one directory is what let "verification" mean
// two unrelated things in one tree.

export { AuthorizationGate, describeRule, type ToolCallContext } from './gate.js'
export { defaultSandboxedGateConfig, defaultSandboxedShellGateConfig } from './presets.js'
export { evaluateRule } from './rules.js'

// A named permission stance: what the gate allows, what the sandbox must
// actually enforce for that to be safe, and who answers the rest. The three
// were configured independently and had to agree by hand.
export {
	PERMISSION_PRESETS,
	SANDBOXED_PRESET,
	SANDBOXED_SHELL_PRESET,
	SUPERVISED_PRESET,
	UNATTENDED_PRESET,
	UnsupportedPermissionPresetError,
	availablePermissionPresets,
	permissionPreset,
	resolvePermissionPreset,
} from './permission-presets.js'
export type { PermissionPreset } from './permission-presets.js'
