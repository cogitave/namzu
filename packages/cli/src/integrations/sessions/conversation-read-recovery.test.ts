import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type SessionId,
	type ToolContext,
	createSessionTextEvidenceSource,
	createUserMessage,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { recordTurn } from '../../__fixtures__/session-log.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	buildConversationReadTool,
	readConversationEvidence,
	releaseConversationEvidence,
	searchConversation,
} from './conversation-search.js'
import { conversationLogPath, openSessions, startConversation } from './store.js'

/**
 * The read tool over a real recorded session log whose assistant text mixes
 * one-, two-, three- and four-byte characters, so a byte offset can fall in the
 * middle of a character, past the end, or on a cursor the process forgot.
 * Nothing here is mocked: the SDK reader answers, the host adapts its answer.
 */

const roots: string[] = []
const owners: { sessions: Awaited<ReturnType<typeof openSessions>>; sessionId: SessionId }[] = []
afterEach(async () => {
	for (const { sessions, sessionId } of owners.splice(0))
		await releaseConversationEvidence(sessions, sessionId)
	for (const root of roots.splice(0)) removeTempDir(root)
})

const UNIT = 'héllo wörld ✓ 日本語 🙂 '
const MARKER = 'NEEDLE-日本-🙂-end'
const TEXT = `${UNIT.repeat(300)}${MARKER}`

async function conversation(text = TEXT) {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-read-recovery-'))
	const home = mkdtempSync(join(tmpdir(), 'namzu-read-recovery-home-'))
	roots.push(cwd, home)
	const sessions = await openSessions(cwd, { stateRoot: home })
	const sessionId = await startConversation(sessions)
	owners.push({ sessions, sessionId })
	await recordTurn(sessions, sessionId, [createUserMessage('what did you print?')], {
		records: [
			{
				type: 'tool_completed',
				toolUseId: 'call-1',
				toolName: 'observe',
				isError: false,
				result: text,
				outputTruncated: false,
			},
		],
	})
	const found = await searchConversation(sessions, sessionId, { query: 'NEEDLE' })
	const match = found.matches[0]
	if (!match) throw new Error('fixture expected the recorded text to be searchable')
	const resolveScope = () => ({ sessions, sessionId })
	const context = { abortSignal: new AbortController().signal } as unknown as ToolContext
	const tool = buildConversationReadTool(resolveScope)
	return {
		sessions,
		sessionId,
		match,
		seq: match.seq,
		part: match.part,
		call: async (input: Record<string, unknown>) => {
			const out = await tool.execute(input, context)
			return out.success
				? { ok: true as const, page: JSON.parse(out.output), error: '' }
				: { ok: false as const, page: undefined, error: out.error ?? '' }
		},
	}
}

/** Byte offsets of the first `日` (3 bytes) and the first `🙂` (4 bytes) in the text. */
const CJK = Buffer.byteLength(TEXT.slice(0, TEXT.indexOf('日')))
const EMOJI = Buffer.byteLength(TEXT.slice(0, TEXT.indexOf('🙂')))
const TOTAL_BYTES = Buffer.byteLength(TEXT)

describe('read_conversation over a real recorded log', () => {
	it('shows what the reader does with an offset inside a character, so the cause is not a guess', async () => {
		const f = await conversation()
		const source = createSessionTextEvidenceSource({
			scope: {
				tenantId: f.sessions.tenantId,
				projectId: f.sessions.projectId,
				sessionId: f.sessionId,
			},
			logPath: conversationLogPath(f.sessions, f.sessionId),
			consistency: 'snapshot',
		})
		const found = await source.search({ seq: f.seq, part: f.part, limit: 1 })
		const address = found.matches[0]?.address ?? ''

		await expect(source.read({ address, byteOffset: CJK + 1 })).rejects.toThrow()
		await expect(source.read({ address, byteOffset: TOTAL_BYTES + 5 })).rejects.toThrow(
			/exceeds retained text/,
		)
		await expect(source.read({ address, byteOffset: CJK })).resolves.toMatchObject({
			byteOffset: CJK,
		})
	})

	it.each([
		['one byte into a three-byte character', CJK + 1, CJK],
		['two bytes into a three-byte character', CJK + 2, CJK],
		['one byte into a four-byte character', EMOJI + 1, EMOJI],
		['three bytes into a four-byte character', EMOJI + 3, EMOJI],
	])('snaps an offset %s back to the start of that character', async (_name, wanted, start) => {
		const f = await conversation()

		const r = await f.call({ seq: f.seq, part: f.part, byteOffset: wanted })

		expect(r.ok).toBe(true)
		const expected = Buffer.from(TEXT).subarray(start).toString('utf8').slice(0, 6000)
		expect(r.page.text).toBe(expected)
		expect(r.page.text.startsWith(wanted === CJK + 1 || wanted === CJK + 2 ? '日' : '🙂')).toBe(
			true,
		)
		expect(r.page.note).toMatch(/inside a character.*byteOffset/)
		expect(r.page.offset).toBe(TEXT.indexOf(r.page.text.slice(0, 2)))
	})

	it('reads an exact character boundary with no adjustment note, naming the next call', async () => {
		const f = await conversation()

		const r = await f.call({ seq: f.seq, part: f.part, byteOffset: CJK })

		expect(r.page.note).not.toMatch(/inside a character|ignored|past the end/)
		expect(r.page.complete).toBe(false)
		expect(r.page.note).toContain(`call read_conversation with seq ${f.seq}, part ${f.part}`)
		expect(r.page.note).toContain(`byteOffset ${CJK}`)
		expect(r.page.note).toContain('nextCursor')
		expect(r.page.text.startsWith('日')).toBe(true)
	})

	it('answers an offset past the end with an empty, complete page that carries totalChars', async () => {
		const f = await conversation()

		const r = await f.call({ seq: f.seq, part: f.part, byteOffset: TOTAL_BYTES + 100 })

		expect(r.ok).toBe(true)
		expect(r.page).toMatchObject({ text: '', complete: true, totalChars: TEXT.length })
		expect(r.page.nextCursor).toBeUndefined()
		expect(r.page.note).toMatch(/past the end of this record/)
	})

	it('answers an offset exactly at the end the same way', async () => {
		const f = await conversation()

		const r = await f.call({ seq: f.seq, part: f.part, byteOffset: TOTAL_BYTES })

		expect(r.page).toMatchObject({ text: '', complete: true })
		expect(r.page.note).toMatch(/nothing left to read/)
	})

	it('treats an offset that is not a nonnegative integer as absent, and says so', async () => {
		const f = await conversation()
		const bad = await readConversationEvidence(f.sessions, f.sessionId, {
			seq: f.seq,
			part: f.part,
			byteOffset: -4,
		})
		const fractional = await readConversationEvidence(f.sessions, f.sessionId, {
			seq: f.seq,
			part: f.part,
			byteOffset: 1.5,
		})

		for (const page of [bad, fractional]) {
			expect(page.text.startsWith('héllo')).toBe(true)
			expect(page.note).toMatch(/not a nonnegative integer/)
		}
	})

	it('continues a snapped read by cursor to the very end, repeating the offset unchanged', async () => {
		const f = await conversation()
		const wanted = CJK + 1
		let page = (await f.call({ seq: f.seq, part: f.part, byteOffset: wanted })).page
		let text = page.text
		while (page.nextCursor) {
			page = (
				await f.call({ seq: f.seq, part: f.part, byteOffset: wanted, cursor: page.nextCursor })
			).page
			expect(page.note).toBeUndefined()
			text += page.text
		}

		expect(text).toBe(TEXT.slice(TEXT.indexOf('日')))
		expect(page.complete).toBe(true)
	})

	it('restarts from the address when the cursor is gone, and says so', async () => {
		const f = await conversation()
		const first = (await f.call({ seq: f.seq, part: f.part })).page
		expect(first.nextCursor).toBeDefined()
		await releaseConversationEvidence(f.sessions, f.sessionId)

		const again = await f.call({ seq: f.seq, part: f.part, cursor: first.nextCursor })

		expect(again.ok).toBe(true)
		expect(again.page.note).toMatch(/cursor had expired.*restarted at the start of seq/)
		expect(again.page.text).toBe(first.text)
	})

	it('refuses a cursor from a different read instead of guessing, naming the next step', async () => {
		const f = await conversation()
		const first = (await f.call({ seq: f.seq, part: f.part })).page

		const r = await f.call({ seq: f.seq, part: f.part, byteOffset: CJK, cursor: first.nextCursor })

		expect(r.ok).toBe(false)
		expect(r.error).toMatch(/different read.*leave the cursor out/)
	})

	it('names the highest retained seq when the seq is past the end of the conversation', async () => {
		const f = await conversation()

		const r = await f.call({ seq: 279 })

		expect(r.ok).toBe(false)
		expect(r.error).toMatch(/seq 279 is past the end.*highest retained seq is \d+/)
	})

	it('names the parts that hold text when the part does not exist', async () => {
		const f = await conversation()

		const r = await f.call({ seq: f.seq, part: 9 })

		expect(r.ok).toBe(false)
		expect(r.error).toMatch(
			new RegExp(`no retained textual part 9: seq ${f.seq} holds text in part 0`),
		)
	})

	it('says a record holds no text when it has none, rather than the log is broken', async () => {
		const f = await conversation()

		const r = await f.call({ seq: 1 })

		expect(r.ok).toBe(false)
		expect(r.error).toMatch(/seq 1 holds no recorded text/)
		expect(r.error).toMatch(/search_conversation/)
	})

	it('rejects a malformed address with a short instruction', async () => {
		const f = await conversation()

		const r = await f.call({ seq: 0 })

		expect(r.ok).toBe(false)
		expect(r.error).toMatch(/positive record sequence/)
	})
})

/** A later turn lands in the log, as every tool call of a running conversation does. */
async function grow(f: Awaited<ReturnType<typeof conversation>>, times = 1) {
	for (let i = 0; i < times; i++)
		await recordTurn(f.sessions, f.sessionId, [createUserMessage(`later question ${i}`)])
}

describe('a seq far past the end of a recorded log', () => {
	it('is answered with the highest retained seq, not an empty page and a cursor', async () => {
		const f = await conversation()

		const r = await f.call({ seq: 99999 })

		expect(r.ok).toBe(false)
		expect(r.error).toMatch(/seq 99999 is past the end.*highest retained seq is \d+/)
		expect(r.error).toMatch(/search_conversation/)
	})
})

describe('read_conversation after the log has grown', () => {
	it('reads the match a search just returned, at its byteOffset, once more was recorded', async () => {
		const f = await conversation()
		const wanted = f.match.byteOffset
		expect(wanted).toBeGreaterThan(0)
		await grow(f)

		const r = await f.call({ seq: f.seq, part: f.part, byteOffset: wanted })

		expect(r.ok).toBe(true)
		expect(r.page.text).toContain('NEEDLE')
		expect(r.page.note).toBeUndefined()
	})

	it('reads from the start after a search and a later record, without a byteOffset', async () => {
		const f = await conversation()
		await grow(f)

		const r = await f.call({ seq: f.seq, part: f.part })

		expect(r.ok).toBe(true)
		expect(r.page.text.startsWith('héllo')).toBe(true)
	})

	it('pages a long multi-byte record to the end by cursor while the log keeps growing', async () => {
		const long = `${UNIT.repeat(900)}${MARKER}`
		const f = await conversation(long)
		let page = (await f.call({ seq: f.seq, part: f.part })).page
		expect(page.complete).toBe(false)
		let text = page.text
		let pages = 1
		while (page.nextCursor) {
			await grow(f)
			const r = await f.call({ seq: f.seq, part: f.part, cursor: page.nextCursor })
			expect(r.ok).toBe(true)
			page = r.page
			text += page.text
			pages++
		}

		expect(pages).toBeGreaterThan(2)
		expect(text).toBe(long)
		expect(page.complete).toBe(true)
	})
})

describe('read_conversation over records that are hard to page', () => {
	const pageAll = async (f: Awaited<ReturnType<typeof conversation>>, byteOffset?: number) => {
		let r = await f.call({ seq: f.seq, part: f.part, ...(byteOffset ? { byteOffset } : {}) })
		expect(r.ok).toBe(true)
		let text = r.page.text
		let pages = 1
		while (r.page.nextCursor) {
			r = await f.call({
				seq: f.seq,
				part: f.part,
				...(byteOffset ? { byteOffset } : {}),
				cursor: r.page.nextCursor,
			})
			expect(r.ok).toBe(true)
			text += r.page.text
			pages++
		}
		return { text, pages }
	}

	it('pages one huge line of four-byte characters to the end without splitting a pair', async () => {
		const line = `NEEDLE${'\u{1F642}'.repeat(10_000)}`
		const f = await conversation(line)

		const { text, pages } = await pageAll(f)

		expect(pages).toBeGreaterThan(2)
		expect(text).toBe(line)
		expect(text).not.toMatch(
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
		)
	})

	it('pages a record with an unpaired surrogate and a run of replacement characters', async () => {
		const odd = `NEEDLE a\uD800b${'\uFFFD'.repeat(7000)}c\uDC00d`
		const f = await conversation(odd)

		const { text } = await pageAll(f)

		// A lone surrogate cannot be stored as UTF-8; it is kept as U+FFFD.
		expect(text).toBe(odd.replace(/[\uD800-\uDFFF]/g, '\uFFFD'))
	})

	it('snaps an offset inside a replacement character in the same record', async () => {
		const odd = `NEEDLE a\uD800b${'\uFFFD'.repeat(10)}`
		const f = await conversation(odd)
		const at = Buffer.byteLength('NEEDLE a')

		const r = await f.call({ seq: f.seq, part: f.part, byteOffset: at + 1 })

		expect(r.ok).toBe(true)
		expect(r.page.note).toMatch(/inside a character/)
		expect(r.page.text.startsWith('\uFFFDb')).toBe(true)
	})

	it('reads a record with lines ended by carriage returns exactly', async () => {
		const crlf = `NEEDLE one\r\ntwo\rthree\r\n${'x'.repeat(7000)}`
		const f = await conversation(crlf)

		const { text } = await pageAll(f)

		expect(text).toBe(crlf)
	})
})
