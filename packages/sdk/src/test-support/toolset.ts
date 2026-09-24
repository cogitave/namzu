/**
 * Test-only toolset builders, replacing the pattern every test used to
 * repeat by hand: `const tools = new ToolRegistry(); tools.register(a);
 * tools.register(b)`.
 *
 * `ToolRegistry` is gone (plan.md v3 §2); a test that only wants to hand
 * `query()`/`ReactiveAgentConfig`/… a fixed set of tools now builds a
 * `Toolset` instead. `testToolset` covers the common, all-active case; a
 * test that needs a deferred tool wraps a second call with `deferred(...)`
 * (`toolsets/wrappers.ts`) and passes both in the `toolsets` array — there
 * is no single-call equivalent of `register(tool, 'deferred')` here on
 * purpose, since a `Toolset`'s availability is a whole-toolset default, not
 * a per-tool one.
 */

import { toolset } from '../toolsets/toolset.js'
import type { Toolset } from '../toolsets/types.js'
import type { ToolDefinition } from '../types/tool/index.js'

/** A plain, all-active `Toolset` named `'test'`, from a fixed list of tools. */
export function testToolset(...tools: readonly ToolDefinition[]): Toolset {
	return toolset('test', tools)
}
