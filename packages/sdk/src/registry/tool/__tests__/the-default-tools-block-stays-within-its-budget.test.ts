import { describe, expect, it } from 'vitest'

import { testToolset } from '../../../test-support/toolset.js'
import { getBuiltinTools } from '../../../tools/builtins/index.js'
import { ToolManager } from '../../../toolsets/manager.js'

/**
 * The `tools` block of a first request, sized.
 *
 * The block renders at position 0 of every request, inside the cached prefix,
 * and is paid for on every turn of every session. Growth is quiet: one more
 * field description on one tool never fails anything, so the block only ever
 * gets larger. This test makes growth a decision. It serialises what a driver
 * is handed for the default builtin toolset, with no host-added tools, and
 * holds it under a committed ceiling.
 *
 * RAISING THE CEILING: edit `CEILING_BYTES` and add one line to `REASONS`
 * saying what the new bytes buy the model. A change that only moves wording
 * around should not need to; trim the text instead.
 *
 * SCOPE: this sizes the `tools` block only. The system prompt a host assembles
 * (the CLI adds its own sections) is not measured here.
 *
 * Deterministic: the schemas are rendered from the source, nothing here reads
 * a clock, a network or the host.
 */
const CEILING_BYTES = 17_000

const REASONS: readonly string[] = [
	'Initial ceiling: 16498 bytes measured when this gate landed (nine tools), plus about 3% headroom for wording fixes.',
]

function defaultToolsBlock() {
	const manager = new ToolManager({
		toolsets: [testToolset(...getBuiltinTools())],
		messages: () => [],
	})
	return manager.toLLMTools()
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

describe('the default tools block', () => {
	it('stays under its committed byte ceiling', () => {
		const block = defaultToolsBlock()
		const total = bytes(block)
		const perTool = block
			.map((tool) => `${tool.function.name}=${bytes(tool)}`)
			.sort()
			.join(', ')
		expect(
			total,
			`The default tools block is ${total} bytes, over the ${CEILING_BYTES} ceiling (${perTool}). Trim the text, or raise CEILING_BYTES and add a reason to REASONS. Reasons so far: ${REASONS.join(' | ')}`,
		).toBeLessThanOrEqual(CEILING_BYTES)
	})

	it('renders the same bytes twice', () => {
		expect(JSON.stringify(defaultToolsBlock())).toBe(JSON.stringify(defaultToolsBlock()))
	})
})
