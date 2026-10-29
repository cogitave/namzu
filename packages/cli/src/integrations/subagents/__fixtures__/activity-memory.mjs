import { randomBytes } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'

const { SubagentActivityMonitor } = await import(process.argv[2])
if (!global.gc) throw new Error('The activity memory fixture requires --expose-gc')

const monitor = new SubagentActivityMonitor()
const tracker = monitor.begin({ agentId: 'memory-probe', description: 'Inspect', prompt: 'Read' })
const resultCodeUnits = 1_000_000
const resultCount = 80

function collect() {
	global.gc()
	global.gc()
	return process.memoryUsage().heapUsed
}

function completeTool(index) {
	const toolUseId = `memory-${index}`
	tracker.onEvent({ type: 'tool_executing', toolUseId, toolName: 'read', input: {} })
	// Distinct, heap-backed strings; repeat() alone can stay an inexpensive rope.
	const result = `${index}:${randomBytes(resultCodeUnits / 2).toString('hex')}`
	tracker.onEvent({ type: 'tool_completed', toolUseId, toolName: 'read', result, isError: false })
}

await setImmediate()
const baseline = collect()
for (let index = 0; index < resultCount; index += 1) completeTool(index)
await setImmediate()
const heapGrowth = collect() - baseline
const rows = monitor.getSnapshot().flatMap((activity) => activity.transcript)
const retainedCodeUnits = rows.reduce(
	(total, row) => total + row.text.length + ('detail' in row ? (row.detail?.length ?? 0) : 0),
	0,
)
monitor.close()
process.stdout.write(
	JSON.stringify({ heapGrowth, resultCount, resultCodeUnits, rowCount: rows.length, retainedCodeUnits }),
)
