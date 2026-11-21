import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	utimesSync,
	writeFileSync,
} from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DiskSessionLeaseStore,
	type Message,
	type SessionId,
	createUserMessage,
	generateMessageId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { recordTurn } from '../../__fixtures__/session-log.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	CLEANUP_NOTICE_GRACE_MS,
	CLEANUP_STATE_FILE,
	type ConversationCleanupOptions,
	cleanupOldConversations,
} from './cleanup.js'
import { PROMPT_HISTORY_FILE, appendPromptHistory, readPromptHistory } from './prompt-history.js'
import {
	type CliSessions,
	closeSessions,
	openConversationLog,
	openSessions,
	startConversation,
} from './store.js'

const DAY = 24 * 60 * 60 * 1000
const dirs: string[] = []
const opened: CliSessions[] = []
afterEach(() => {
	for (const s of opened.splice(0)) closeSessions(s)
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

async function temp(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix))
	dirs.push(dir)
	return dir
}

async function project(): Promise<CliSessions> {
	const s = await openSessions(await temp('namzu-cleanup-cwd-'), {
		stateRoot: await temp('namzu-cleanup-home-'),
	})
	opened.push(s)
	return s
}

async function conversation(s: CliSessions, origin?: { protocol: 'desktop' }): Promise<SessionId> {
	const id = await startConversation(s, origin ? { origin } : undefined)
	await recordTurn(s, id, [
		createUserMessage('hello'),
		{ role: 'assistant', content: 'hi' } as Message,
	])
	return id
}

/** Set every file of a conversation to `at`, as if nothing had written it since. */
function age(s: CliSessions, id: SessionId, at: number): void {
	const stamp = new Date(at)
	const walk = (path: string) => {
		if (!existsSync(path)) return
		if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) walk(join(path, name))
		utimesSync(path, stamp, stamp)
	}
	walk(s.paths.sessionDir({ sessionId: id }))
	walk(s.paths.sessionLog({ sessionId: id }))
}

const NOW = Date.now()

function run(s: CliSessions, more: Partial<ConversationCleanupOptions> = {}) {
	return cleanupOldConversations({
		home: s.root,
		now: NOW,
		periodDays: 30,
		explicit: true,
		everyMs: 0,
		tempRoot: null,
		onScreen: () => new Set(),
		...more,
	})
}

const present = (s: CliSessions, id: SessionId) => existsSync(s.paths.sessionLog({ sessionId: id }))

describe('removing old conversations', () => {
	it('removes a conversation untouched for longer than the period, folder and all, and keeps a recent one', async () => {
		const s = await project()
		const old = await conversation(s)
		const recent = await conversation(s)
		age(s, old, NOW - 31 * DAY)
		age(s, recent, NOW - 29 * DAY)
		const report = await run(s)
		expect(report).toMatchObject({ ran: true, mode: 'removed', conversations: 1 })
		expect(present(s, old)).toBe(false)
		expect(existsSync(s.paths.sessionDir({ sessionId: old }))).toBe(false)
		expect(present(s, recent)).toBe(true)
		expect(existsSync(join(s.paths.projectDir(), 'project.json'))).toBe(true)
		const fresh = await openSessions(s.projectRoot, { stateRoot: s.root })
		opened.push(fresh)
		const rows = await fresh.index.listSessions({ slug: s.slug })
		expect(rows.map((row) => row.id)).toEqual([recent])
	})

	it('keeps an old conversation whose turn is open, one the desktop app started, and one in an untrusted folder', async () => {
		const s = await project()
		const open = await startConversation(s)
		const log = openConversationLog(s, open)
		const lease = await log.claim({ holder: 'test-open-turn', ttlMs: 10_000 })
		if (!lease) throw new Error('no lease')
		const userMessageId = generateMessageId()
		const started = await log.beginTurn(lease, {
			turnId: '019a0000-0000-7000-8000-00000000000a' as never,
			userMessageId,
			config: { model: 'test-model', tokenBudget: 1, timeoutMs: 1 },
		})
		await log.append(lease, {
			type: 'message',
			turnId: started.record.turnId as never,
			messageId: userMessageId,
			role: 'user',
			kind: 'prompt',
			content: createUserMessage('still going'),
		})
		await log.release(lease)
		const desktop = await conversation(s, { protocol: 'desktop' })
		for (const id of [open, desktop]) age(s, id, NOW - 90 * DAY)
		const report = await run(s)
		expect(report).toMatchObject({ conversations: 0, kept: 2 })
		expect(present(s, open) && present(s, desktop)).toBe(true)

		const untrusted = await conversation(s)
		age(s, untrusted, NOW - 90 * DAY)
		expect((await run(s, { isTrusted: () => false })).conversations).toBe(0)
		expect(present(s, untrusted)).toBe(true)
	})

	it('never removes the conversation this process opens, one on screen elsewhere, or one a writer holds', async () => {
		const s = await project()
		const mine = await conversation(s)
		const shown = await conversation(s)
		const held = await conversation(s)
		for (const id of [mine, shown, held]) age(s, id, NOW - 90 * DAY)
		// A live writer lease: the sweep's own claim is refused, so it removes nothing.
		const writer = await new DiskSessionLeaseStore(s.paths.sessionDir({ sessionId: held })).claim({
			holder: 'another-process',
			ttlMs: 10 * 60_000,
		})
		expect(writer).not.toBeNull()
		age(s, held, NOW - 90 * DAY)
		const report = await run(s, {
			keep: new Set([mine]),
			onScreen: () => new Set([shown]),
		})
		expect(report.conversations).toBe(0)
		for (const id of [mine, shown, held]) expect(present(s, id)).toBe(true)
	})

	it('keeps a log it cannot read', async () => {
		const s = await project()
		const id = await conversation(s)
		writeFileSync(s.paths.sessionLog({ sessionId: id }), 'damaged\n')
		age(s, id, NOW - 90 * DAY)
		expect((await run(s)).conversations).toBe(0)
		expect(readFileSync(s.paths.sessionLog({ sessionId: id }), 'utf8')).toBe('damaged\n')
	})

	it('removes a folder left without its conversation once it is as old, and leaves the rest of the project alone', async () => {
		const s = await project()
		const orphan = '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b' as SessionId
		const dir = s.paths.sessionDir({ sessionId: orphan })
		mkdirSync(join(dir, 'tool-results'), { recursive: true })
		writeFileSync(join(dir, 'tool-results', 'x.txt'), 'x')
		mkdirSync(join(s.paths.projectDir(), 'memory'), { recursive: true })
		writeFileSync(join(s.paths.projectDir(), 'memory', 'note.md'), 'kept')
		age(s, orphan, NOW - 90 * DAY)
		utimesSync(join(s.paths.projectDir(), 'memory', 'note.md'), new Date(0), new Date(0))
		const report = await run(s)
		expect(report.folders).toBe(1)
		expect(existsSync(dir)).toBe(false)
		expect(readFileSync(join(s.paths.projectDir(), 'memory', 'note.md'), 'utf8')).toBe('kept')
	})

	it('drops prompt history lines older than the period with the conversations', async () => {
		const s = await project()
		const base = { project: s.projectRoot, sessionId: 'x' }
		await appendPromptHistory(s.root, { ...base, display: 'old', timestamp: NOW - 40 * DAY })
		await appendPromptHistory(s.root, { ...base, display: 'new', timestamp: NOW - DAY })
		const report = await run(s)
		expect(report.historyLines).toBe(1)
		expect((await readPromptHistory(s.root)).entries.map((e) => e.display)).toEqual(['new'])
	})

	it('removes the old conversation’s scratch folder with it', async () => {
		const s = await project()
		const id = await conversation(s)
		age(s, id, NOW - 31 * DAY)
		const tempRoot = await temp('namzu-cleanup-temp-')
		const scratch = join(tempRoot, s.slug, id, 'scratchpad')
		mkdirSync(scratch, { recursive: true })
		await run(s, { tempRoot })
		expect(existsSync(join(tempRoot, s.slug, id))).toBe(false)
	})
})

describe('when the sweep runs', () => {
	it('removes nothing when the period could not be read, or is not a whole number of days', async () => {
		const s = await project()
		const id = await conversation(s)
		age(s, id, NOW - 400 * DAY)
		for (const periodDays of [undefined, 0, -5, 1.5]) {
			expect((await run(s, { periodDays })).ran).toBe(false)
		}
		expect(present(s, id)).toBe(true)
		expect(existsSync(join(s.root, PROMPT_HISTORY_FILE))).toBe(false)
	})

	it('runs at most once a day', async () => {
		const s = await project()
		expect((await run(s, { everyMs: DAY })).ran).toBe(true)
		const id = await conversation(s)
		age(s, id, NOW - 90 * DAY)
		expect((await run(s, { everyMs: DAY, now: NOW + DAY / 2 })).ran).toBe(false)
		expect(present(s, id)).toBe(true)
		expect((await run(s, { everyMs: DAY, now: NOW + DAY + 1 })).conversations).toBe(1)
	})

	it('with the default period, counts and tells the person first, and removes a week after telling them', async () => {
		const s = await project()
		const id = await conversation(s)
		age(s, id, NOW - 90 * DAY)
		const first = await run(s, { explicit: false, settingsFile: '~/.namzu/config.yaml' })
		expect(first).toMatchObject({ mode: 'counted', conversations: 1 })
		expect(first.notice).toMatch(/keeps conversations on this computer for 30 days/)
		expect(first.notice).toMatch(/cleanupPeriodDays in ~\/\.namzu\/config\.yaml/)
		expect(present(s, id)).toBe(true)
		const state = JSON.parse(readFileSync(join(s.root, CLEANUP_STATE_FILE), 'utf8'))
		expect(Date.parse(state.noticeShownAt)).toBe(NOW)

		const during = await run(s, { explicit: false, now: NOW + CLEANUP_NOTICE_GRACE_MS - 1 })
		expect(during).toMatchObject({ mode: 'counted' })
		expect(during.notice).toBeUndefined()
		expect(present(s, id)).toBe(true)

		const after = await run(s, { explicit: false, now: NOW + CLEANUP_NOTICE_GRACE_MS })
		expect(after).toMatchObject({ mode: 'removed', conversations: 1 })
		expect(present(s, id)).toBe(false)
	})

	it('starts the week only once there is something to tell', async () => {
		const s = await project()
		const quiet = await run(s, { explicit: false })
		expect(quiet.notice).toBeUndefined()
		const state = JSON.parse(readFileSync(join(s.root, CLEANUP_STATE_FILE), 'utf8'))
		expect(state.noticeShownAt).toBeUndefined()
	})

	it('skips the sweep while another process holds it', async () => {
		const s = await project()
		writeFileSync(join(s.root, `${CLEANUP_STATE_FILE}.lock`), `${process.pid}:0:held`)
		expect((await run(s)).ran).toBe(false)
	})
})
