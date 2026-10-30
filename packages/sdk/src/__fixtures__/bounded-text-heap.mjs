import { randomBytes } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { applyToolOutputBudget } from '../../dist/runtime/query/tool-output-budget.js'
import { windowText } from '../../dist/tools/text-window.js'

const mode = process.argv[2]
const count = 12
const sourceBytes = 4 * 1024 * 1024
if (typeof global.gc !== 'function') throw new Error('Run this fixture with --expose-gc.')

function retainedView(index) {
	// JSON produces a flat heap string; unique random bodies cannot be deduplicated.
	const source = JSON.parse(
		JSON.stringify({ body: randomBytes((sourceBytes * 3) / 4).toString('base64') }),
	).body
	if (mode === 'budget') {
		return applyToolOutputBudget({
			toolName: 'private_fixture',
			toolUseId: `fixture_${index}`,
			output: source,
			maxChars: 40_000,
		}).output
	}
	if (mode === 'window') return windowText(source)
	if (mode === 'short-window') return windowText(source.slice(1_024, 7_024))
	throw new Error(`Unknown fixture mode: ${mode}`)
}

async function collect() {
	await setImmediate()
	global.gc()
	await setImmediate()
	global.gc()
}

retainedView(-1)
await collect()
const baseline = process.memoryUsage().heapUsed
const views = Array.from({ length: count }, (_, index) => retainedView(index))
await collect()
const held = process.memoryUsage().heapUsed
// Read the retained values after GC, without serializing and flattening them.
const retainedChars = views.reduce(
	(sum, view) => sum + (typeof view === 'string' ? view.length : view.head.length + (view.tail?.length ?? 0)),
	0,
)
process.stdout.write(
	`${JSON.stringify({ mode, sourceBytes: sourceBytes * count, retainedChars, baseline, held, growth: held - baseline })}\n`,
)
