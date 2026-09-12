import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createUserMessage } from '../../../types/message/index.js'
import { asRunId } from '../../../utils/id.js'
import { RunDiskStore } from '../../run/disk.js'
import {
	compactionArchiveDirectory,
	compactionArchiveSchema,
	compactionPartPath,
} from '../compaction-archive.js'
import { createDiskRunTextEvidenceSource } from '../disk.js'

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-compaction-archive-'))
	roots.push(root)
	const scope = {
		tenantId: randomUUID(),
		projectId: randomUUID(),
		sessionId: randomUUID(),
		runId: asRunId(randomUUID()),
	}
	const store = new RunDiskStore({ baseDir: root })
	const runDir = await store.initRun(scope.runId)
	await writeFile(
		join(runDir, 'run.json'),
		JSON.stringify({ id: scope.runId, status: 'completed', metadata: { scope } }),
	)
	await store.appendEvent({ type: 'run_started', runId: scope.runId, seq: 1 })
	const message = createUserMessage('ORCHID retained receipt', [
		{ data: 'A'.repeat(4 * 1024 * 1024), mediaType: 'image/png' },
	])
	const append = () =>
		store.appendEvent({
			type: 'compaction_shed',
			runId: scope.runId,
			seq: 2,
			iteration: 0,
			reason: 'manual',
			messages: [message],
		})
	const source = () =>
		createDiskRunTextEvidenceSource({ scope, runDir, indexDir: join(runDir, 'evidence-index') })
	return { root, scope, store, runDir, message, append, source }
}

it.each(['text', 'manifest', 'missing'] as const)(
	'refuses changed retained compaction evidence (%s)',
	async (kind) => {
		const f = await fixture()
		await f.append()
		const source = f.source()
		const match = (await source.search({ query: 'ORCHID' })).matches[0]!
		expect(match).toBeDefined()
		const lines = (await readFile(join(f.runDir, 'transcript.jsonl'), 'utf8')).trim().split('\n')
		const record = compactionArchiveSchema.parse(JSON.parse(lines[1]!))
		const path = compactionPartPath(f.runDir, record.archive.id, 0)
		if (kind === 'missing') await rm(path)
		else if (kind === 'manifest') await writeFile(`${path}.manifest.json`, '{}')
		else await writeFile(path, 'ORCHID modified receipt')
		await expect(source.read({ address: match.address })).rejects.toThrow()
	},
)

it('refuses a damaged whole-message archive without inventing a partial history', async () => {
	const f = await fixture()
	await f.append()
	const record = compactionArchiveSchema.parse(
		JSON.parse((await readFile(join(f.runDir, 'transcript.jsonl'), 'utf8')).trim().split('\n')[1]!),
	)
	const path = join(compactionArchiveDirectory(f.runDir, record.archive.id), 'messages.json')
	await writeFile(path, '[]')
	await expect(f.store.readEvents()).rejects.toThrow('archive size changed')
	// Text is independently authenticated; damage to the whole body does not
	// turn the separately retained original text into a reconstructed preview.
	const source = f.source()
	const match = (await source.search({ query: 'ORCHID' })).matches[0]!
	expect((await source.read({ address: match.address })).text).toBe(f.message.content)
	// A later-events request does not reload earlier message bodies.
	expect(await f.store.readEvents({ sinceSeq: 2 })).toEqual([])
})

it('never follows an archive directory symlink or publishes its reference after a write refusal', async () => {
	const f = await fixture()
	const outside = await mkdtemp(join(tmpdir(), 'namzu-outside-archive-'))
	roots.push(outside)
	await symlink(
		outside,
		join(f.runDir, 'compaction-output'),
		process.platform === 'win32' ? 'junction' : 'dir',
	)
	await expect(f.append()).rejects.toThrow('symlinks')
	expect(await f.store.readEvents()).toHaveLength(1)
})

it('refuses an invalid archive address instead of consulting a model-chosen path', async () => {
	const f = await fixture()
	await f.append()
	const path = join(f.runDir, 'transcript.jsonl')
	const lines = (await readFile(path, 'utf8')).trim().split('\n')
	const record = JSON.parse(lines[1]!)
	record.archive.id = '../outside'
	lines[1] = JSON.stringify(record)
	await writeFile(path, `${lines.join('\n')}\n`)
	await expect(f.source().search({ query: 'ORCHID' })).rejects.toThrow()
	await expect(f.store.readEvents()).rejects.toThrow()
})
