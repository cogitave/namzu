import { access, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { RunQuery, RunTranscriptUnavailableError } from '../../../run-query/index.js'
import type { RunId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { Message } from '../../../types/message/index.js'
import type { Run } from '../../../types/run/entity.js'
import type { RunStore } from '../../../types/run/store.js'
import { RunDiskStore, readRunMessagesIn } from '../disk.js'
import { InMemoryRunStore } from '../memory.js'

const LOG = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn(() => LOG),
}

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
})

async function baseDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-messages-'))
	dirs.push(dir)
	return dir
}

async function backends(): Promise<[string, RunStore][]> {
	const disk = new RunDiskStore({ baseDir: await baseDir(), logger: LOG })
	await disk.initRun('4df6f44c-825b-4240-9aca-4c583dcc5d00')
	const memory = new InMemoryRunStore()
	await memory.initRun('4df6f44c-825b-4240-9aca-4c583dcc5d00')
	return [
		['disk', disk],
		['memory', memory],
	]
}

const runWith = (messages: Message[]): Run => ({ messages }) as Run

describe('message snapshot publication has disk/memory parity', () => {
	it('distinguishes never-persisted from an explicitly persisted empty snapshot', async () => {
		for (const [name, store] of await backends()) {
			expect(await store.readMessages(), name).toEqual({
				kind: 'unavailable',
				reason: 'not-persisted',
			})

			await store.writeMessages(runWith([]), 7)

			expect(await store.readMessages(), name).toEqual({
				kind: 'available',
				throughEventSeq: 7,
				messages: [],
			})
		}
	})

	it('round-trips the exact event boundary and message content', async () => {
		for (const [name, store] of await backends()) {
			await store.writeMessages(runWith([createUserMessage(`hello from ${name}`)]), 19)

			expect(await store.readMessages(), name).toMatchObject({
				kind: 'available',
				throughEventSeq: 19,
				messages: [{ role: 'user', content: `hello from ${name}` }],
			})
		}
	})

	it('does not hand callers a mutable reference into either backend', async () => {
		for (const [name, store] of await backends()) {
			const original = createUserMessage('original')
			await store.writeMessages(runWith([original]), 4)
			const first = await store.readMessages()
			expect(first.kind, name).toBe('available')
			if (first.kind !== 'available') continue
			;(first.messages[0] as { content: string }).content = 'caller mutation'
			original.content = 'writer mutation'

			const second = await store.readMessages()
			expect(second.kind, name).toBe('available')
			if (second.kind !== 'available') continue
			expect(second.messages[0]?.content, name).toBe('original')
		}
	})
})

describe('reading disk snapshots without creating a run', () => {
	it('refuses the exact crash window after terminal evidence but before message publication', async () => {
		const dir = await baseDir()
		const store = new RunDiskStore({ baseDir: dir, logger: LOG })
		await store.initRun('38c4a6f2-db75-4392-a019-1fe7f4d2773b')
		await store.appendEvent({
			type: 'run_started',
			runId: '38c4a6f2-db75-4392-a019-1fe7f4d2773b',
			seq: 1,
		} as never)
		await store.appendEvent({
			type: 'compaction_shed',
			runId: '38c4a6f2-db75-4392-a019-1fe7f4d2773b',
			iteration: 1,
			reason: 'threshold',
			messages: [createUserMessage('shed before the crash')],
			seq: 2,
		} as never)
		await store.appendEvent({
			type: 'run_completed',
			runId: '38c4a6f2-db75-4392-a019-1fe7f4d2773b',
			result: '',
			seq: 3,
		} as never)
		// `persist()` writes this metadata first. The simulated process dies
		// before `writeMessages`, which is the ambiguity this contract closes.
		await store.writeRunMeta({
			id: '38c4a6f2-db75-4392-a019-1fe7f4d2773b' as RunId,
			status: 'completed',
			metadata: {},
			tokenUsage: {},
			currentIteration: 1,
			startedAt: 1,
			messages: [],
		} as unknown as Run)

		await expect(new RunQuery({ store }).fullTranscript()).rejects.toMatchObject({
			name: RunTranscriptUnavailableError.name,
			reason: 'message-snapshot-not-persisted',
			eventHeadSeq: 3,
		})
	})

	it('reports a missing file as unavailable and creates nothing', async () => {
		const dir = await baseDir()
		const missing = join(dir, '2d4692b7-c804-46a8-9844-68007671f067')

		expect(await readRunMessagesIn(missing)).toEqual({
			kind: 'unavailable',
			reason: 'not-persisted',
		})
		await expect(access(missing)).rejects.toThrow()
	})

	it('preserves old raw arrays as readable but unverified', async () => {
		const dir = await baseDir()
		const runDir = join(dir, '1e2cd7b1-df8e-4f19-9f3b-4f0281300ae7')
		const store = new RunDiskStore({ baseDir: dir, logger: LOG })
		await store.initRun('1e2cd7b1-df8e-4f19-9f3b-4f0281300ae7')
		await writeFile(
			join(runDir, 'messages.json'),
			JSON.stringify([createUserMessage('legacy content')]),
			'utf-8',
		)

		expect(await readRunMessagesIn(runDir)).toMatchObject({
			kind: 'legacy-unverified',
			messages: [{ content: 'legacy content' }],
		})
	})

	it.each([
		['invalid JSON', '{'],
		['a wrong object shape', JSON.stringify({ messages: [] })],
	])('refuses %s rather than degrading it to an empty snapshot', async (_name, raw) => {
		const dir = await baseDir()
		const runDir = join(dir, '8f0153ed-d172-4d0f-9381-d4acef0595ff')
		const store = new RunDiskStore({ baseDir: dir, logger: LOG })
		await store.initRun('8f0153ed-d172-4d0f-9381-d4acef0595ff')
		await writeFile(join(runDir, 'messages.json'), raw, 'utf-8')

		await expect(readRunMessagesIn(runDir)).rejects.toThrow('Invalid run message snapshot')
	})
})

describe('the in-memory store starts a different run unpublished', () => {
	it('does not carry a previous run snapshot across a rebind', async () => {
		const store = new InMemoryRunStore()
		await store.initRun('111b6f53-2d7f-4bfc-bbe1-56df51712736')
		await store.writeMessages(runWith([createUserMessage('first')]), 3)

		await store.initRun('3140f049-2def-4029-8534-4bcc8840fc38')

		expect(await store.readMessages()).toEqual({
			kind: 'unavailable',
			reason: 'not-persisted',
		})
	})
})
