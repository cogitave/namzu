/**
 * Resuming a conversation, and — mostly — refusing to.
 *
 * The rule under test: when the named conversation cannot be resumed, this
 * REFUSES and names the cause. It never falls back to a fresh session, and it
 * never resumes with a partial history.
 *
 * Both fallbacks would be invisible from outside. The user asked for a specific
 * conversation, would get something that looks like one, and would find out
 * several turns later having already acted on it. A half-context is the worse
 * of the two: it is not a degraded context, it is a different context that lies
 * about being complete.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CliSessions } from '../../integrations/sessions/store.js'
import { listRecent, loadResumableConversation } from '../../integrations/sessions/store.js'
import { resolveResume } from '../resume.js'

vi.mock('../../integrations/sessions/store.js', () => ({
	listRecent: vi.fn(),
	loadResumableConversation: vi.fn(),
}))

const sessions = {} as CliSessions
const CWD = '/projects/foo'

function recent(...ids: string[]) {
	vi.mocked(listRecent).mockResolvedValue(
		ids.map((id, i) => ({
			id: id as never,
			title: id,
			// These fixtures predate `/title`, so none of them is named — which
			// is also the state this command has to keep working in.
			named: false,
			updatedAt: `2026-08-0${i + 1}T00:00:00Z`,
			count: 2,
		})),
	)
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('asking for nothing', () => {
	it('is a fresh run, not an error', async () => {
		const out = await resolveResume(sessions, { continueLast: false, sessionId: null }, CWD)

		expect(out.kind).toBe('fresh')
	})
})

describe('--continue', () => {
	it('takes the most recent conversation', async () => {
		recent('ses_new', 'ses_old')
		vi.mocked(loadResumableConversation).mockResolvedValue([
			{ role: 'user', content: 'hi', timestamp: 0 },
		] as never)

		const out = await resolveResume(sessions, { continueLast: true, sessionId: null }, CWD)

		expect(out).toMatchObject({ kind: 'resumed', sessionId: 'ses_new' })
	})

	it('refuses with its OWN sentence when there is nothing here', async () => {
		// Not "cannot resume" — the cause is different and so is the fix. Someone
		// with no conversation here is usually standing in the wrong directory,
		// so the message has to point at --cwd rather than at a broken store.
		recent()

		const out = await resolveResume(sessions, { continueLast: true, sessionId: null }, CWD)

		expect(out.kind).toBe('error')
		expect(out).toMatchObject({ message: expect.stringContaining('no previous conversation') })
		expect(out).toMatchObject({ message: expect.stringContaining(CWD) })
		expect(out).toMatchObject({ message: expect.stringContaining('--cwd') })
	})

	it('surfaces a workspace admission refusal instead of treating it as empty', async () => {
		vi.mocked(listRecent).mockRejectedValue(new Error('Project prj_closed is archived'))

		const out = await resolveResume(sessions, { continueLast: true, sessionId: null }, CWD)

		expect(out).toEqual({
			kind: 'error',
			message: expect.stringContaining('Project prj_closed is archived'),
		})
	})
})

describe('--resume <id>', () => {
	it('takes the conversation it was given, not the most recent', async () => {
		recent('ses_new')
		vi.mocked(loadResumableConversation).mockResolvedValue([
			{ role: 'user', content: 'hi', timestamp: 0 },
		] as never)

		const out = await resolveResume(sessions, { continueLast: false, sessionId: 'ses_wanted' }, CWD)

		expect(out).toMatchObject({ kind: 'resumed', sessionId: 'ses_wanted' })
		expect(listRecent).not.toHaveBeenCalled()
		expect(loadResumableConversation).toHaveBeenCalledWith(sessions, 'ses_wanted')
	})

	it('refuses an exact id the store cannot admit, and names the cause', async () => {
		// THE case. Starting fresh would hand back something indistinguishable
		// from what was asked for.
		vi.mocked(loadResumableConversation).mockRejectedValue(
			new Error('Conversation ses_gone was not found — resume conversation rejected'),
		)

		const out = await resolveResume(sessions, { continueLast: false, sessionId: 'ses_gone' }, CWD)

		expect(out.kind).toBe('error')
		expect(out).toMatchObject({ message: expect.stringContaining('ses_gone') })
		expect(out).toMatchObject({ message: expect.stringContaining('was not found') })
	})

	it('names the cwd searched by an exact-id refusal', async () => {
		vi.mocked(loadResumableConversation).mockRejectedValue(new Error('not found'))

		const out = await resolveResume(sessions, { continueLast: false, sessionId: 'ses_gone' }, CWD)

		expect(out).toMatchObject({ message: expect.stringContaining(CWD) })
	})

	it('refuses rather than resuming with a partial history', async () => {
		// The half-context case. Carrying on with an empty transcript would look
		// exactly like a resumed session to the user and to the model.
		vi.mocked(loadResumableConversation).mockRejectedValue(new Error('transcript is corrupt'))

		const out = await resolveResume(sessions, { continueLast: false, sessionId: 'ses_a' }, CWD)

		expect(out.kind).toBe('error')
		expect(out).toMatchObject({ message: expect.stringContaining('transcript is corrupt') })
	})

	it('refuses an empty transcript rather than calling it resumed', async () => {
		vi.mocked(loadResumableConversation).mockResolvedValue([])

		const out = await resolveResume(sessions, { continueLast: false, sessionId: 'ses_a' }, CWD)

		expect(out.kind).toBe('error')
		expect(out).toMatchObject({ message: expect.stringContaining('no messages') })
	})
})

describe('the two flags together', () => {
	it('refuses, because they name different conversations', async () => {
		const out = await resolveResume(sessions, { continueLast: true, sessionId: 'ses_a' }, CWD)

		expect(out.kind).toBe('error')
		expect(out).toMatchObject({ message: expect.stringContaining('Pass one') })
	})
})

describe('no store at all', () => {
	it('refuses instead of quietly starting fresh', async () => {
		const out = await resolveResume(null, { continueLast: true, sessionId: null }, CWD)

		expect(out.kind).toBe('error')
		expect(out).toMatchObject({ message: expect.stringContaining('nothing to resume') })
	})

	it('still runs fresh when nothing was asked for', async () => {
		const out = await resolveResume(null, { continueLast: false, sessionId: null }, CWD)

		expect(out.kind).toBe('fresh')
	})
})
