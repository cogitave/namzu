import {
	chmodSync,
	existsSync,
	lstatSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Message, type SessionId, createUserMessage } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { recordTurn } from '../../__fixtures__/session-log.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	PROMPT_HISTORY_FILE,
	PROMPT_HISTORY_KEEP,
	PROMPT_HISTORY_SEEDED_MARKER,
	type PromptHistoryEntry,
	appendPromptHistory,
	loggedPromptsOf,
	pastedTextsOf,
	promptHistoryEntryFor,
	promptHistorySkipped,
	promptLooksSensitive,
	readPromptHistory,
	recallPromptHistory,
	rewritePromptHistory,
	seedPromptHistory,
	trimPromptHistory,
} from './prompt-history.js'
import { closeSessions, openSessions, startConversation } from './store.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

async function temp(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix))
	dirs.push(dir)
	return dir
}

const SESSION = '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b'
const OTHER = '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7c'
const noWait = async () => {}

function entry(display: string, extra: Partial<PromptHistoryEntry> = {}): PromptHistoryEntry {
	return { display, project: '/work/app', sessionId: SESSION, timestamp: 1000, ...extra }
}

function user(content: string, pasted?: { start: number; end: number }[]): Message {
	const message = createUserMessage(content)
	return (
		pasted
			? {
					...message,
					pasted: pasted.map((range, i) => ({ ...range, nonce: `${i}`.padStart(8, '0') })),
				}
			: message
	) as Message
}

describe('what one sent prompt becomes', () => {
	it('keeps what was typed and cuts each pasted stretch out, saying where it goes back', () => {
		const text = 'compare this: PASTED-BODY and that'
		const start = text.indexOf('PASTED-BODY')
		const line = promptHistoryEntryFor({
			text,
			pasted: [{ start, end: start + 'PASTED-BODY'.length }],
			project: '/work/app',
			sessionId: SESSION,
			timestamp: 5,
		})
		expect(line?.display).toBe('compare this:  and that')
		expect(line?.pasted).toEqual([
			{
				offset: start,
				length: 'PASTED-BODY'.length,
				sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
		])
		expect(JSON.stringify(line)).not.toContain('PASTED-BODY')
	})

	it('keeps nothing for an empty prompt, a credential, a sign-in code or ranges that do not fit', () => {
		const base = { project: '/p', sessionId: SESSION, timestamp: 1 }
		expect(promptHistoryEntryFor({ ...base, text: '   ' })).toBeUndefined()
		expect(
			promptHistoryEntryFor({ ...base, text: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 here' }),
		).toBeUndefined()
		expect(
			promptHistoryEntryFor({ ...base, text: '/login https://example.test/cb?code=x' }),
		).toBeUndefined()
		expect(
			promptHistoryEntryFor({ ...base, text: 'abc', pasted: [{ start: 2, end: 9 }] }),
		).toBeUndefined()
		expect(
			promptHistoryEntryFor({
				...base,
				text: 'abcdef',
				pasted: [
					{ start: 2, end: 4 },
					{ start: 3, end: 5 },
				],
			}),
		).toBeUndefined()
		expect(promptHistoryEntryFor({ ...base, text: 'x'.repeat(64 * 1024 + 1) })).toBeUndefined()
	})

	it('treats a pasted secret as not copied, so only the typed part is checked', () => {
		const text = 'look: ghp_abcdefghijklmnopqrstuvwxyz0123456789'
		const start = text.indexOf('ghp_')
		const line = promptHistoryEntryFor({
			text,
			pasted: [{ start, end: text.length }],
			project: '/p',
			sessionId: SESSION,
			timestamp: 1,
		})
		expect(line?.display).toBe('look: ')
	})

	it('says /login alone and an ordinary prompt are not sensitive', () => {
		expect(promptLooksSensitive('/login')).toBe(false)
		expect(promptLooksSensitive('fix the token parser')).toBe(false)
	})

	it('is skipped in a process a session started', () => {
		expect(promptHistorySkipped({ NAMZU_STARTED_BY_SESSION: '1' })).toBe(true)
		expect(promptHistorySkipped({})).toBe(false)
	})
})

describe('the history file', () => {
	it('is appended one line per prompt, private, and read back', async () => {
		const home = await temp('namzu-history-home-')
		expect(await appendPromptHistory(home, entry('first'))).toBe(true)
		expect(await appendPromptHistory(home, entry('second', { timestamp: 2000 }))).toBe(true)
		const path = join(home, PROMPT_HISTORY_FILE)
		expect(statSync(path).mode & 0o777).toBe(0o600)
		expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2)
		const read = await readPromptHistory(home)
		expect(read.entries.map((e) => e.display)).toEqual(['first', 'second'])
		expect(existsSync(`${path}.lock`)).toBe(false)
	})

	it('tightens a file other users could read before it adds to it', async () => {
		const home = await temp('namzu-history-home-')
		const path = join(home, PROMPT_HISTORY_FILE)
		writeFileSync(path, '', { mode: 0o644 })
		chmodSync(path, 0o644)
		await appendPromptHistory(home, entry('x'))
		expect(statSync(path).mode & 0o777).toBe(0o600)
	})

	it('refuses a link and writes nothing through it', async () => {
		const home = await temp('namzu-history-home-')
		const elsewhere = join(await temp('namzu-history-elsewhere-'), 'target')
		writeFileSync(elsewhere, 'untouched\n')
		symlinkSync(elsewhere, join(home, PROMPT_HISTORY_FILE))
		expect(await appendPromptHistory(home, entry('x'))).toBe(false)
		expect(readFileSync(elsewhere, 'utf8')).toBe('untouched\n')
		expect((await readPromptHistory(home)).entries).toEqual([])
		expect(await rewritePromptHistory(home, () => false, { wait: noWait })).toBe(0)
		expect(lstatSync(join(home, PROMPT_HISTORY_FILE)).isSymbolicLink()).toBe(true)
	})

	it('skips a line that is not an entry when reading, and keeps it when rewriting', async () => {
		const home = await temp('namzu-history-home-')
		const path = join(home, PROMPT_HISTORY_FILE)
		writeFileSync(
			path,
			`${JSON.stringify(entry('old', { timestamp: 1 }))}\nnot json\n${JSON.stringify(entry('new', { timestamp: 9 }))}\n`,
			{ mode: 0o600 },
		)
		expect((await readPromptHistory(home)).entries.map((e) => e.display)).toEqual(['old', 'new'])
		expect(await rewritePromptHistory(home, (e) => e.timestamp > 5, { wait: noWait })).toBe(1)
		expect(readFileSync(path, 'utf8')).toBe(
			`not json\n${JSON.stringify(entry('new', { timestamp: 9 }))}\n`,
		)
		expect(statSync(path).mode & 0o777).toBe(0o600)
	})

	it('waits for a writer that holds the lock, and gives the line up rather than the prompt', async () => {
		const home = await temp('namzu-history-home-')
		writeFileSync(join(home, `${PROMPT_HISTORY_FILE}.lock`), `${process.pid}:0:held`)
		let waits = 0
		expect(
			await appendPromptHistory(home, entry('x'), {
				attempts: 3,
				wait: async () => {
					waits += 1
				},
			}),
		).toBe(false)
		expect(waits).toBe(2)
		expect(existsSync(join(home, PROMPT_HISTORY_FILE))).toBe(false)
	})

	it('trims to the newest lines once it has grown well past them', async () => {
		const home = await temp('namzu-history-home-')
		const lines = PROMPT_HISTORY_KEEP + 501
		writeFileSync(
			join(home, PROMPT_HISTORY_FILE),
			`${Array.from({ length: lines }, (_, i) => JSON.stringify(entry(`p${i}`, { timestamp: i }))).join('\n')}\n`,
			{ mode: 0o600 },
		)
		expect(await trimPromptHistory(home, PROMPT_HISTORY_KEEP + 10, { wait: noWait })).toBe(0)
		expect(await trimPromptHistory(home, lines, { wait: noWait })).toBe(501)
		const read = await readPromptHistory(home)
		expect(read.entries).toHaveLength(PROMPT_HISTORY_KEEP)
		expect(read.entries[0]?.display).toBe('p501')
	})
})

describe('recalling earlier prompts', () => {
	it('gives this project’s prompts oldest first, without other projects, its own lines or repeats in a row', async () => {
		const home = await temp('namzu-history-home-')
		for (const line of [
			entry('one', { timestamp: 1 }),
			entry('elsewhere', { timestamp: 2, project: '/other' }),
			entry('two', { timestamp: 3 }),
			entry('two', { timestamp: 4, sessionId: OTHER }),
			entry('mine now', { timestamp: 50 }),
		])
			await appendPromptHistory(home, line)
		const recalled = await recallPromptHistory({
			home,
			project: '/work/app',
			before: 10,
			pastesOf: async () => new Map(),
		})
		expect(recalled).toEqual(['one', 'two'])
	})

	it('puts pasted text back from the conversation’s own log, and leaves out a prompt whose paste is gone', async () => {
		const s = await openSessions(await temp('namzu-history-cwd-'), {
			stateRoot: await temp('namzu-history-home-'),
		})
		try {
			const id = await startConversation(s)
			const text = 'review BIG PASTE please'
			const start = text.indexOf('BIG PASTE')
			const range = { start, end: start + 'BIG PASTE'.length }
			await recordTurn(s, id, [
				user(text, [range]),
				{ role: 'assistant', content: 'ok' } as Message,
			])
			const kept = promptHistoryEntryFor({
				text,
				pasted: [range],
				project: s.projectRoot,
				sessionId: id,
				timestamp: 1,
			}) as PromptHistoryEntry
			await appendPromptHistory(s.root, kept)
			await appendPromptHistory(s.root, { ...kept, sessionId: OTHER, timestamp: 2 })
			const recalled = await recallPromptHistory({
				home: s.root,
				project: s.projectRoot,
				pastesOf: (sessionId) => pastedTextsOf(s, sessionId),
			})
			expect(recalled).toEqual([text])
		} finally {
			closeSessions(s)
		}
	})

	it('leaves out the conversation the box already holds', async () => {
		const home = await temp('namzu-history-home-')
		await appendPromptHistory(home, entry('resumed one', { timestamp: 1 }))
		await appendPromptHistory(home, entry('earlier', { timestamp: 2, sessionId: OTHER }))
		expect(
			await recallPromptHistory({
				home,
				project: '/work/app',
				excludeSession: SESSION,
				pastesOf: async () => new Map(),
			}),
		).toEqual(['earlier'])
	})
})

describe('seeding from conversations kept before the file existed', () => {
	async function withConversations() {
		const s = await openSessions(await temp('namzu-history-cwd-'), {
			stateRoot: await temp('namzu-history-home-'),
		})
		const a = await startConversation(s)
		await recordTurn(s, a, [user('first prompt'), { role: 'assistant', content: 'ok' } as Message])
		await recordTurn(s, a, [
			user('first prompt'),
			{ role: 'assistant', content: 'again' } as Message,
		])
		const b = await startConversation(s)
		const pasted = 'see: PASTE'
		await recordTurn(s, b, [
			user(pasted, [{ start: 5, end: 10 }]),
			{ role: 'assistant', content: 'ok' } as Message,
		])
		return { s, a, b }
	}

	function seed(
		s: Awaited<ReturnType<typeof openSessions>>,
		ids: readonly SessionId[],
		wait: () => Promise<void> = noWait,
	) {
		return seedPromptHistory({
			home: s.root,
			project: s.projectRoot,
			projectDir: s.paths.projectDir(),
			conversations: async () => ids,
			promptsOf: (id) => loggedPromptsOf(s, id),
			wait,
		})
	}

	it('reads the typed prompts of each conversation, once, and recalls them whole', async () => {
		const { s, a, b } = await withConversations()
		try {
			expect(await seed(s, [b, a])).toBe(3)
			expect(existsSync(join(s.paths.projectDir(), PROMPT_HISTORY_SEEDED_MARKER))).toBe(true)
			expect(await seed(s, [b, a])).toBe(0)
			const file = readFileSync(join(s.root, PROMPT_HISTORY_FILE), 'utf8')
			expect(file).not.toContain('PASTE')
			const recalled = await recallPromptHistory({
				home: s.root,
				project: s.projectRoot,
				pastesOf: (id) => pastedTextsOf(s, id),
			})
			expect(recalled).toEqual(['first prompt', 'see: PASTE'])
		} finally {
			closeSessions(s)
		}
	})

	it('does not add a line the file already has, and keeps every line it had', async () => {
		const { s, a, b } = await withConversations()
		try {
			const already = promptHistoryEntryFor({
				text: 'first prompt',
				project: s.projectRoot,
				sessionId: a,
				timestamp: 1,
			}) as PromptHistoryEntry
			await appendPromptHistory(s.root, already)
			await appendPromptHistory(s.root, entry('another project', { project: '/other' }))
			expect(await seed(s, [b, a])).toBe(2)
			const read = await readPromptHistory(s.root)
			expect(read.entries.filter((e) => e.display === 'first prompt')).toHaveLength(2)
			expect(read.entries.some((e) => e.display === 'another project')).toBe(true)
		} finally {
			closeSessions(s)
		}
	})

	it('skips a conversation whose log cannot be read and seeds the others', async () => {
		const { s, a, b } = await withConversations()
		try {
			writeFileSync(s.paths.sessionLog({ sessionId: a }), 'not a log\n')
			expect(await seed(s, [b, a])).toBe(1)
		} finally {
			closeSessions(s)
		}
	})

	it('seeds once when two starts race for it', async () => {
		const { s, a, b } = await withConversations()
		try {
			// Whichever start finds the lock held waits for the other to finish: no clock decides it.
			const runs: Promise<number>[] = []
			runs.push(
				seed(s, [b, a], async () => {
					await runs[1]?.catch(() => 0)
				}),
			)
			runs.push(
				seed(s, [b, a], async () => {
					await runs[0]?.catch(() => 0)
				}),
			)
			const counts = await Promise.all(runs)
			expect(counts.sort()).toEqual([0, 3])
			expect((await readPromptHistory(s.root)).entries).toHaveLength(3)
		} finally {
			closeSessions(s)
		}
	})

	it('leaves the runtime’s own user messages out', async () => {
		const s = await openSessions(await temp('namzu-history-cwd-'), {
			stateRoot: await temp('namzu-history-home-'),
		})
		try {
			const id = await startConversation(s)
			await recordTurn(s, id, [
				user('typed'),
				{
					role: 'user',
					content: 'a reminder the host wrote',
					source: { type: 'runtime-context', kind: 'reminder' },
				} as Message,
			])
			expect((await loggedPromptsOf(s, id)).map((p) => p.content)).toEqual(['typed'])
		} finally {
			closeSessions(s)
		}
	})
})
