import { mkdtemp, readFile, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { fixtureId } from '../../../test-support/ids.js'
import { InMemoryRunStore } from '../memory.js'
import { ToolExecutionCollector, readToolExecutionsIn } from '../tool-executions.js'

const roots: string[] = []
const id = fixtureId.run('tool-recovery')
afterEach(async () => {
	await removeTempDirs(roots.splice(0))
})
const events = [
	{ type: 'run_started', runId: id, seq: 1 },
	{
		type: 'tool_completed',
		runId: id,
		seq: 2,
		toolUseId: 'done',
		toolName: 'effect',
		result: 'receipt α🦉',
		isError: false,
	},
	{ type: 'tool_executing', runId: id, seq: 3, toolUseId: 'uncertain', toolName: 'effect' },
]
async function file(text = events.map((e) => JSON.stringify(e)).join('\n') + '\n') {
	const root = await mkdtemp(join(tmpdir(), 'namzu-tool-executions-'))
	roots.push(root)
	const path = join(root, 'transcript.jsonl')
	await writeFile(path, text)
	return path
}
it('distinguishes completed, started and absent calls without altering the log', async () => {
	const path = await file()
	const original = await readFile(path)
	const snapshot = await readToolExecutionsIn(path, id, ['done', 'uncertain', 'untouched'])
	expect(snapshot.complete).toBe(true)
	expect(snapshot.records.get('done')).toMatchObject({ status: 'completed', result: 'receipt α🦉' })
	expect(snapshot.records.get('uncertain')).toMatchObject({ status: 'started' })
	expect(snapshot.records.has('untouched')).toBe(false)
	expect(await readFile(path)).toEqual(original)
})
it('invalidates a previous completion when a retry starts', () => {
	const collector = new ToolExecutionCollector(id, ['done'])
	for (const event of events) collector.accept(event)
	collector.accept({
		type: 'tool_executing',
		runId: id,
		seq: 4,
		toolUseId: 'done',
		toolName: 'effect',
	})
	expect(collector.finish().records.get('done')?.status).toBe('started')
})
it('returns incomplete for a torn tail and preserves it byte-for-byte', async () => {
	const path = await file(events.map((e) => JSON.stringify(e)).join('\n') + '\n{"type":"tool_exe')
	const original = await readFile(path)
	expect((await readToolExecutionsIn(path, id, ['done'])).complete).toBe(false)
	expect(await readFile(path)).toEqual(original)
})
it.each(['gap', 'foreign', 'malformed', 'no-start', 'invalid-result'] as const)(
	'refuses %s execution evidence',
	async (kind) => {
		const data = events.map((e) => ({ ...e }))
		if (kind === 'gap') data[1]!.seq = 9
		if (kind === 'foreign') data[1]!.runId = fixtureId.run('foreign')
		if (kind === 'no-start') data[0]!.type = 'tool_executing'
		if (kind === 'invalid-result') delete data[1]!.result
		const path = await file(
			data.map((e) => JSON.stringify(e)).join('\n') + (kind === 'malformed' ? '\n{bad}\n' : '\n'),
		)
		await expect(readToolExecutionsIn(path, id, ['done'])).rejects.toThrow()
	},
)
it('does not decode archived compaction attachments during an execution scan', async () => {
	const path = await file(
		JSON.stringify(events[0]) +
			'\n' +
			JSON.stringify({
				type: 'compaction_shed',
				runId: id,
				seq: 2,
				compaction_archive: { missing: 'deliberately-not-loaded' },
			}) +
			'\n',
	)
	expect((await readToolExecutionsIn(path, id, ['untouched'])).complete).toBe(true)
})
it('enforces cancellation and scan size bounds', async () => {
	const path = await file()
	await expect(readToolExecutionsIn(path, id, [], AbortSignal.abort())).rejects.toThrow()
	await expect(readToolExecutionsIn(path, id, Array(4097).fill('x'))).rejects.toThrow('4096')
	await writeFile(path, ' '.repeat(4 * 1024 * 1024 + 1))
	await expect(readToolExecutionsIn(path, id, [])).rejects.toThrow('4 MiB')
	await truncate(path, 256 * 1024 * 1024 + 1)
	await expect(readToolExecutionsIn(path, id, [])).rejects.toThrow('256 MiB')
})

it('refuses invalid UTF-8 instead of silently replacing result bytes', async () => {
	const path = await file()
	const valid = await readFile(path)
	valid[valid.indexOf(Buffer.from('receipt'))] = 0xff
	await writeFile(path, valid)
	await expect(readToolExecutionsIn(path, id, ['done'])).rejects.toThrow()
})

it('honors cancellation even in an empty memory store', async () => {
	const store = new InMemoryRunStore()
	await store.initRun(id)
	await expect(store.readToolExecutions([], AbortSignal.abort())).rejects.toThrow()
})
