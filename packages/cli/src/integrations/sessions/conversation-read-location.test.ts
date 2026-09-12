import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
	RunDiskStore,
	type SessionId,
	createUserMessage,
	generateMessageId,
	generateRunId,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	readConversationEvidence,
	releaseConversationEvidence,
	searchConversation,
} from './conversation-search.js'
import { CliPathBuilder } from './paths.js'
import { type CliSessions, openSessions, startConversation } from './store.js'

const roots: string[] = []
const owners: { sessions: CliSessions; sessionId: SessionId }[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const owner of owners.splice(0))
		await releaseConversationEvidence(owner.sessions, owner.sessionId)
	for (const root of roots.splice(0)) removeTempDir(root)
})

async function fixture(mode: 'live' | 'closed' = 'closed', texts?: string[]) {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-read-location-'))
	roots.push(cwd)
	const sessions = await openSessions(cwd)
	const sessionId = await startConversation(sessions)
	owners.push({ sessions, sessionId })
	const runId = generateRunId()
	const path = new CliPathBuilder(sessions.root).runDir(sessions.projectId, sessionId, runId)
	const store = new RunDiskStore({ baseDir: dirname(path) })
	await store.initRun(runId)
	const scope = { tenantId: sessions.tenantId, projectId: sessions.projectId, sessionId, runId }
	const metadata = (status: string, session = sessionId) =>
		writeFile(
			join(path, 'run.json'),
			JSON.stringify({ id: runId, status, metadata: { scope: { ...scope, sessionId: session } } }),
		)
	await metadata(mode === 'live' ? 'running' : 'completed')
	await store.appendEvent({ type: 'run_started', runId, seq: 1 })
	const contents =
		texts ??
		Array.from({ length: 70 }, (_, i) =>
			i === 69 ? 'α🦉 ORCHID original receipt' : `Ordinary message ${i}`,
		)
	await store.appendEvent({
		type: 'compaction_shed',
		runId,
		seq: 2,
		iteration: 1,
		reason: 'threshold',
		messages: contents.map((text) => createUserMessage(text)),
	})
	const active =
		mode === 'live'
			? { runId, captureRunEvidence: (bytes?: number) => store.captureTextEvidence(scope, bytes) }
			: undefined
	const search = (cursor?: string) =>
		searchConversation(
			sessions,
			sessionId,
			cursor ? { cursor } : { query: 'ORCHID', runId },
			undefined,
			active,
		)
	const find = async () => {
		let page = await search()
		for (let i = 0; page.matches.length === 0 && page.nextCursor && i < 5; i++)
			page = await search(page.nextCursor)
		expect(page.unavailableRuns).toBe(0)
		expect(page.matches.length).toBeGreaterThan(0)
		return page.matches[0]!
	}
	const read = (input: Parameters<typeof readConversationEvidence>[2], signal?: AbortSignal) =>
		readConversationEvidence(sessions, sessionId, input, signal, active)
	return { sessions, sessionId, path, runId, store, metadata, active, search, find, read }
}

it.each(['live', 'closed'] as const)(
	'recovers a late multipart address without a search cache (%s)',
	async (mode) => {
		const f = await fixture(mode)
		const page = await f.read({ runId: f.runId, seq: 2, part: 69 })
		expect(page.text).toBe('α🦉 ORCHID original receipt')
		expect(page.complete).toBe(true)
		expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
	},
)

it.each(['live', 'closed'] as const)(
	'reads a late search match directly with fresh source checks (%s)',
	async (mode) => {
		const f = await fixture(mode)
		const match = await f.find()
		expect(match.part).toBe(69)
		const page = await f.read(match)
		expect(page.text).toBe('α🦉 ORCHID original receipt')
		expect(page.complete).toBe(true)
		expect(page.retainedPreview).toBe(false)
		expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
		await expect(f.read(match, AbortSignal.abort(new Error('operator cancelled')))).rejects.toThrow(
			'operator cancelled',
		)
		const controller = new AbortController()
		const load = f.sessions.store.getSession.bind(f.sessions.store)
		vi.spyOn(f.sessions.store, 'getSession').mockImplementationOnce(async (...args) => {
			const session = await load(...args)
			controller.abort(new Error('cancelled during scope lookup'))
			return session
		})
		await expect(f.read(match, controller.signal)).rejects.toThrow('cancelled during scope lookup')
	},
)

it('rejects a changed closed record after search instead of silently reading a replacement', async () => {
	const f = await fixture()
	const match = await f.find()
	const path = join(f.path, 'transcript.jsonl')
	await writeFile(
		path,
		(await readFile(path, 'utf8')).replace('original receipt', 'modified receipt'),
	)
	await expect(f.read(match)).rejects.toThrow(/changed|source/)
	const refreshed = await f.find()
	expect((await f.read(refreshed)).text).toBe('α🦉 ORCHID modified receipt')
})

it('does not reuse a location across conversations or changed ownership', async () => {
	const f = await fixture()
	const match = await f.find()
	const foreign = await startConversation(f.sessions)
	await expect(readConversationEvidence(f.sessions, foreign, match)).rejects.toThrow()
	await f.metadata('completed', foreign)
	await expect(f.read(match)).rejects.toThrow('ownership differs')
})

it('continues a long exact read and releases both locations and read cursors', async () => {
	const text = `ORCHID ${'λ🦉\r\n'.repeat(2000)}`
	const f = await fixture('closed', [...Array.from({ length: 69 }, () => 'ordinary'), text])
	const match = await f.find()
	const first = await f.read(match)
	expect(first.text.length).toBeGreaterThan(0)
	expect(first.nextCursor).toBeDefined()
	const second = await f.read({ ...match, cursor: first.nextCursor })
	expect(first.text + second.text).toBe(text)
	expect(second.complete).toBe(true)
	await releaseConversationEvidence(f.sessions, f.sessionId)
	await expect(f.read({ ...match, cursor: first.nextCursor })).rejects.toThrow(
		'expired or is unavailable',
	)
	const uncached = await f.read(match)
	expect(uncached.text).toBe(first.text)
	expect(uncached.nextCursor).toBeDefined()
})

it('locates an expired search address again using bounded index pages', async () => {
	const f = await fixture()
	const match = await f.find()
	vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000 + 1)
	const first = await f.read(match)
	expect(first.text).toBe('α🦉 ORCHID original receipt')
	expect(first.complete).toBe(true)
})

it('can locate a closed run after its former live owner is gone', async () => {
	const f = await fixture('live')
	const match = await f.find()
	await f.metadata('completed')
	const first = await readConversationEvidence(f.sessions, f.sessionId, match)
	expect(first.text).toBe('α🦉 ORCHID original receipt')
	expect(first.complete).toBe(true)
})

it('evicts old locations without losing their durable addresses', async () => {
	const f = await fixture(
		'closed',
		Array.from({ length: 194 }, (_, i) => (i < 64 ? 'ordinary' : `ORCHID original ${i}`)),
	)
	const matches = []
	let cursor: string | undefined
	for (let i = 0; i < 60; i++) {
		const page = await f.search(cursor)
		matches.push(...page.matches)
		cursor = page.nextCursor
		if (!cursor) break
	}
	expect(cursor).toBeUndefined()
	expect(matches).toHaveLength(130)
	const oldest = await f.read(matches[0]!)
	expect(oldest.text).toBe('ORCHID original 64')
	expect(oldest.complete).toBe(true)
	const newest = await f.read(matches.at(-1)!)
	expect(newest.text).toBe('ORCHID original 193')
	expect(newest.complete).toBe(true)
})

it('keeps a live location bound to its captured writer after later appends', async () => {
	const f = await fixture('live')
	const match = await f.find()
	await f.store.appendEvent({
		type: 'message_completed',
		runId: f.runId,
		seq: 3,
		iteration: 1,
		messageId: generateMessageId(),
		stopReason: 'end_turn',
		content: `Later response ${randomUUID()}`,
	})
	expect((await f.read(match)).text).toBe('α🦉 ORCHID original receipt')
})

it('yields after bounded lookup work and resumes beyond hundreds of small parts', async () => {
	const f = await fixture(
		'closed',
		Array.from({ length: 600 }, (_, i) => (i === 599 ? 'late original' : 'ordinary')),
	)
	const address = { runId: f.runId, seq: 2, part: 599 }
	const first = await f.read(address)
	expect(first.text).toBe('')
	expect(first.complete).toBe(false)
	expect(first.nextCursor).toBeDefined()
	expect(first.scannedBytes).toBeLessThan(2 * 1024 * 1024)
	const second = await f.read({ ...address, cursor: first.nextCursor })
	expect(second.text).toBe('late original')
	expect(second.complete).toBe(true)
	expect(second.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
})

it('shares the byte ceiling across lookup pages and resumes an already located original', async () => {
	const f = await fixture('closed', [
		...Array.from({ length: 69 }, () => 'ordinary '.repeat(1800)),
		'α🦉 ORCHID original receipt',
	])
	const address = { runId: f.runId, seq: 2, part: 69 }
	const first = await f.read(address)
	expect(first.text).toBe('')
	expect(first.complete).toBe(false)
	expect(first.nextCursor).toBeDefined()
	expect(first.scannedBytes).toBeGreaterThan(2 * 1024 * 1024)
	expect(first.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
	const second = await f.read({ ...address, cursor: first.nextCursor })
	expect(second.text).toBe('α🦉 ORCHID original receipt')
	expect(second.complete).toBe(true)
	expect(second.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
})

it('reports a missing part after traversing empty lookup pages', async () => {
	const f = await fixture()
	await expect(f.read({ runId: f.runId, seq: 2, part: 70 })).rejects.toThrow(
		'no retained textual part',
	)
})

it('rechecks live scope, cancellation and remaining bytes between lookup operations', async () => {
	const f = await fixture('live')
	for (let seq = 3; seq < 132; seq++)
		await f.store.appendEvent({
			type: 'message_completed',
			runId: f.runId,
			seq,
			iteration: 1,
			messageId: generateMessageId(),
			stopReason: 'end_turn',
			content: 'Later response',
		})
	const address = { runId: f.runId, seq: 2, part: 69 }
	const budgets: number[] = []
	const capture = async (bytes?: number) => {
		const source = await f.active!.captureRunEvidence(bytes)
		if (!source) throw new Error('The fixture must have retained live evidence.')
		return source
	}
	const active = {
		runId: f.runId,
		captureRunEvidence: async (bytes?: number) => {
			budgets.push(bytes!)
			return capture(bytes)
		},
	}
	const page = await readConversationEvidence(f.sessions, f.sessionId, address, undefined, active)
	expect(page.text).toBe('α🦉 ORCHID original receipt')
	expect(budgets.length).toBeGreaterThan(2)
	for (let i = 1; i < budgets.length; i++) expect(budgets[i]).toBeLessThan(budgets[i - 1]!)
	expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)

	const foreign = await startConversation(f.sessions)
	let captures = 0
	await expect(
		readConversationEvidence(f.sessions, f.sessionId, address, undefined, {
			runId: f.runId,
			captureRunEvidence: async (bytes) => {
				const source = await capture(bytes)
				captures++
				return captures === 1
					? source
					: { ...source, scope: { ...source.scope, sessionId: foreign } }
			},
		}),
	).rejects.toThrow('different conversation')
	expect(captures).toBe(2)

	const controller = new AbortController()
	captures = 0
	await expect(
		readConversationEvidence(f.sessions, f.sessionId, address, controller.signal, {
			runId: f.runId,
			captureRunEvidence: async (bytes) => {
				const source = await capture(bytes)
				captures++
				return {
					...source,
					search: async (...args) => {
						const result = await source.search(...args)
						controller.abort(new Error('cancelled between pages'))
						return result
					},
				}
			},
		}),
	).rejects.toThrow('cancelled between pages')
	expect(captures).toBe(1)
})
