/**
 * Where a tool call actually runs.
 *
 * One concept sat in two directories: the base and the local backend here,
 * the remote, hybrid and factory under `connector/execution/`, with
 * `connector/index.ts` reaching into both to reassemble one public export
 * group. A contributor adding a fifth backend had no principled place to
 * put it, and either answer was defensible from where they were standing.
 *
 * They are all here now, and the direction was not free. Folding this down
 * into `connector/` was the other option and it is wrong: `run/command-gate.ts`
 * imports `LocalExecutionContext` directly, so execution is not
 * connector-scoped — a connector is one CALLER of an execution context, not
 * the thing that defines one. `connector/index.ts` re-exports from here so
 * no consumer's import path changes.
 *
 * A sixth backend goes in this directory and is named in this file.
 */

export { BaseExecutionContext } from './base.js'
export { ExecutionContextFactory } from './factory.js'
export { HybridExecutionContext } from './hybrid.js'
export type { HybridExecutionContextOptions } from './hybrid.js'
export { LocalExecutionContext } from './local.js'
export type { LocalExecutionContextOptions } from './local.js'
export { RemoteExecutionContext } from './remote.js'
export type { RemoteExecutionContextOptions } from './remote.js'
