import { mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import {
	generateMessageId,
	generateProjectId,
	generateSessionId,
	generateTurnId,
} from '../../../utils/id.js'
import type { SessionRecordDraft } from '../core.js'
import { DiskLogMedium, DiskSessionLog } from '../disk.js'
import {
	DiskSpillStore,
	InMemorySpillStore,
	SpillIntegrityError,
	sha256Hex,
	spillFileName,
} from '../spill.js'

const made: string[] = []
afterAll(async () => {
	await removeTempDirs(made.splice(0))
})

async function scratch(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-spill-')))
	made.push(root)
	return root
}

describe('a spill', () => {
	it('writes the body and a manifest under tool-results/, named for its key', async () => {
		const dir = await scratch()
		const store = new DiskSpillStore(dir, () => 0)
		const ref = await store.write('toolu_1', 'text', 'hello')
		expect(ref).toEqual({
			path: `tool-results/${spillFileName('toolu_1')}`,
			manifest: `tool-results/${spillFileName('toolu_1')}.manifest.json`,
			bytes: 5,
			sha256: sha256Hex('hello'),
		})
		expect(await readFile(join(dir, ref.path), 'utf8')).toBe('hello')
		expect(JSON.parse(await readFile(join(dir, ref.manifest), 'utf8'))).toEqual({
			v: 1,
			kind: 'spill',
			content: 'text',
			key: 'toolu_1',
			bytes: 5,
			sha256: sha256Hex('hello'),
			createdAt: new Date(0).toISOString(),
		})
		expect(await store.read(ref)).toBe('hello')
		// No temporary file is left behind.
		expect((await readdir(join(dir, 'tool-results'))).sort()).toEqual(
			[spillFileName('toolu_1'), `${spillFileName('toolu_1')}.manifest.json`].sort(),
		)
	})

	it('adopts an identical earlier spill and refuses to replace a different one', async () => {
		for (const store of [new DiskSpillStore(await scratch()), new InMemorySpillStore()]) {
			const ref = await store.write('k', 'text', 'same')
			expect(await store.write('k', 'text', 'same')).toEqual(ref)
			await expect(store.write('k', 'text', 'different')).rejects.toBeInstanceOf(
				SpillIntegrityError,
			)
			expect(await store.read(ref)).toBe('same')
		}
	})

	it('refuses a body that no longer matches its record', async () => {
		const dir = await scratch()
		const store = new DiskSpillStore(dir)
		const ref = await store.write('k', 'text', 'original')
		await writeFile(join(dir, ref.path), 'origin4l')
		await expect(store.read(ref)).rejects.toThrow(/SHA-256/)
		await writeFile(join(dir, ref.path), 'short')
		await expect(store.read(ref)).rejects.toThrow(/bytes/)
		await expect(store.read({ ...ref, path: '../../etc/passwd' })).rejects.toBeInstanceOf(
			SpillIntegrityError,
		)
		await expect(new InMemorySpillStore().read(ref)).rejects.toBeInstanceOf(SpillIntegrityError)
	})

	it('reaches disk before the record that names it', async () => {
		const root = await scratch()
		const sessionId = generateSessionId()
		const sessionDir = join(root, sessionId)
		const file = join(root, `${sessionId}.jsonl`)
		const log = new DiskSessionLog({ sessionId, file, sessionDir, spillAboveBytes: 1024 })
		const lease = await log.claim({ holder: 'a', ttlMs: 60_000 })
		if (lease === null) throw new Error('claim failed')
		await log.append(lease, {
			type: 'session_started',
			projectId: generateProjectId(),
			cwd: '/w',
			agent: { id: 'a', name: 'A' },
		} as SessionRecordDraft)
		const turnId = generateTurnId()
		await log.beginTurn(lease, {
			turnId,
			userMessageId: generateMessageId(),
			config: { model: 'm', tokenBudget: 1, timeoutMs: 1 },
		})
		// Observe the log at the moment the record is appended: its spill must already be there.
		const seen: boolean[] = []
		const append = DiskLogMedium.prototype.append
		const spy = vi.spyOn(DiskLogMedium.prototype, 'append').mockImplementation(async function (
			this: DiskLogMedium,
			bytes,
			offset,
			sync,
		) {
			const line = Buffer.from(bytes).toString('utf8')
			if (line.includes('"spill"')) {
				const record = JSON.parse(line) as { spill: { path: string; manifest: string } }
				const names = await readdir(join(sessionDir, 'tool-results'))
				seen.push(
					names.includes(record.spill.path.split('/')[1] as string) &&
						names.includes(record.spill.manifest.split('/')[1] as string),
				)
			}
			return append.call(this, bytes, offset, sync)
		})
		try {
			const body = 'y'.repeat(8000)
			const entry = await log.append(lease, {
				type: 'message',
				turnId,
				messageId: generateMessageId(),
				role: 'tool',
				content: { role: 'tool', content: body, toolCallId: 'toolu_big' },
			} as SessionRecordDraft)
			const record = entry.record as { spill?: { path: string }; content: { content: string } }
			expect(record.spill?.path).toBe(`tool-results/${spillFileName('toolu_big')}`)
			expect(record.content.content.length).toBeLessThan(body.length)
			expect(seen).toEqual([true])
			const [, folded] = [undefined, (await log.messages()).at(-1)]
			expect(folded).toEqual({ role: 'tool', content: body, toolCallId: 'toolu_big' })
		} finally {
			spy.mockRestore()
		}
	})
})
