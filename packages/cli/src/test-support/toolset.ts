/**
 * Test-only toolset builders, replacing the pattern CLI tests used to repeat
 * by hand: `const registry = new ToolRegistry(); registry.register(a);
 * registry.register(b)`.
 *
 * `ToolRegistry` is gone (plan.md v3 §2); a test that only wants to hand
 * `createAgentSession`/a mocked `query()`/a sub-agent's `buildTools` a fixed
 * set of tools now builds a `Toolset` (or a `ToolManager` over one, when the
 * test also needs `.get`/`.has`/`.sourceOf`/`.execute`) instead. Mirrors
 * `@namzu/sdk`'s own `test-support/toolset.ts`, kept as a separate file here
 * because this package cannot import the SDK's `src/test-support` (it is not
 * part of the published package).
 */

import { type ToolDefinition, ToolManager, type Toolset, toolset } from '@namzu/sdk'

/** A plain, all-active `Toolset` named `'test'`, from a fixed list of tools. */
export function testToolset(...tools: readonly ToolDefinition[]): Toolset {
	return toolset('test', tools)
}

/**
 * A `ToolManager` over a single `'test'` toolset — for a test that needs the
 * execution pipeline (`.execute`/`.prepareExecution`) or the read surface
 * (`.get`/`.has`/`.sourceOf`/`.listNames`) a bare `Toolset` does not have.
 */
export function testToolManager(...tools: readonly ToolDefinition[]): ToolManager {
	return new ToolManager({ toolsets: [testToolset(...tools)], messages: () => [] })
}
