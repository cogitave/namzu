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
const CEILING_BYTES = 19_300

const REASONS: readonly string[] = [
	'Initial ceiling: 16498 bytes measured when this gate landed (nine tools), plus about 3% headroom for wording fixes.',
	'Raised to 18000 at 17466 bytes. grep and glob gained include_ignored and include_hidden, and their descriptions say which files a search skips and when a result is limited (+854). job says whether each running job is progressing, waiting or stalled (+114). About 3% headroom kept.',
	"Raised to 18200 at 18156 bytes. bash says that long output and a background job's output are saved to a file whose path the model is given, so it does not redirect them into files in the working directory (+156). About 1% headroom kept.",
	'Raised to 18500 at 18332 bytes. bash says its command has no input (stdin closed, no terminal) and what to do instead, so the model does not wait on, or loop around, a prompt nobody can answer (+176). About 1% headroom kept.',
	'Raised to 18800 at 18575 bytes. bash takes an optional description, a short label in plain words that the person sees for a background job in place of the command line (+243). About 1% headroom kept.',
	'Raised to 19300 at 19065 bytes. read says what its numbered lines look like (a number, an arrow, then the line as it is) and edit says to copy old_string after the arrow, keeping the tabs and spaces, and that an indentation-only miss on one place is applied and reported (+265). The cost of a tab-indented file edited one level short is a whole refused batch. About 1.2% headroom kept.',
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
