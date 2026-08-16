// This barrel is authorization: a rule engine that decides, BEFORE a tool
// runs, whether the call is permitted. It is not verification, and the
// module-invariant registry that used to sit beside it here moved to
// `src/invariants/` for that reason — see the note on the move in that
// file. Keeping the two in one directory is what let "verification" mean
// two unrelated things in one tree.

export { AuthorizationGate, describeRule, type ToolCallContext } from './gate.js'
export { defaultSandboxedGateConfig, defaultSandboxedShellGateConfig } from './presets.js'
export { evaluateRule } from './rules.js'
