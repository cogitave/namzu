import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	GH_MISSING_NOTICE,
	GH_SIGNED_OUT_NOTICE,
	type PrFooterState,
	PrPoller,
	type RunCommand,
	idleDelayMs,
	lookupPr,
	nextDelayMs,
	parsePrView,
} from './pr-status.js'

const OPEN = JSON.stringify({
	number: 592,
	url: 'https://example.test/o/r/pull/592',
	state: 'OPEN',
	isDraft: false,
	reviewDecision: 'APPROVED',
})

interface Script {
	branch?: string | Error
	defaultBranch?: string | Error
	gh?: string | Error
}

/** A runner that answers git and gh from a script and records every call. */
function scripted(script: Script) {
	const calls: string[] = []
	let current = script
	const run: RunCommand = async (file, args) => {
		calls.push(`${file} ${args.join(' ')}`)
		const answer =
			file === 'gh'
				? current.gh
				: args.includes('refs/remotes/origin/HEAD')
					? current.defaultBranch
					: current.branch
		if (answer === undefined) throw Object.assign(new Error('not configured'), { stderr: '' })
		if (answer instanceof Error) throw answer
		return { stdout: answer }
	}
	return {
		run,
		calls,
		set(next: Script) {
			current = next
		},
		ghCalls: () => calls.filter((c) => c.startsWith('gh ')).length,
	}
}

const spawnError = (code: string) => Object.assign(new Error(code), { code, stderr: '' })
const ghError = (stderr: string) => Object.assign(new Error('exit 1'), { stderr })

describe('parsePrView', () => {
	it('maps review state', () => {
		const base = { number: 7, url: 'https://x.test/7', state: 'OPEN', isDraft: false }
		expect(parsePrView(JSON.stringify({ ...base, reviewDecision: 'APPROVED' }))?.review).toBe(
			'approved',
		)
		expect(
			parsePrView(JSON.stringify({ ...base, reviewDecision: 'CHANGES_REQUESTED' }))?.review,
		).toBe('changes')
		expect(
			parsePrView(JSON.stringify({ ...base, reviewDecision: 'REVIEW_REQUIRED' }))?.review,
		).toBe('pending')
		expect(parsePrView(JSON.stringify({ ...base, reviewDecision: '' }))?.review).toBe('pending')
		expect(parsePrView(JSON.stringify({ ...base, isDraft: true }))?.review).toBe('draft')
		expect(parsePrView(JSON.stringify({ ...base, state: 'MERGED' }))?.review).toBe('merged')
	})

	it('shows nothing for a closed pull request or output it cannot read', () => {
		expect(parsePrView(JSON.stringify({ number: 1, url: 'https://x.test', state: 'CLOSED' }))).toBe(
			null,
		)
		expect(parsePrView('not json')).toBe(null)
		expect(parsePrView('{"number":"1","url":"u"}')).toBe(null)
		expect(parsePrView('null')).toBe(null)
	})
})

describe('lookupPr', () => {
	it('returns the pull request for a feature branch', async () => {
		const r = scripted({ branch: 'ux/footer\n', defaultBranch: 'origin/main\n', gh: OPEN })
		const result = await lookupPr(r.run, '/repo')
		expect(result.state).toEqual({
			kind: 'pr',
			number: 592,
			url: 'https://example.test/o/r/pull/592',
			review: 'approved',
		})
		expect(r.calls.at(-1)).toBe('gh pr view --json number,url,state,isDraft,reviewDecision')
	})

	it.each(['main', 'master'])('never asks gh on %s', async (branch) => {
		const r = scripted({ branch, gh: OPEN })
		expect((await lookupPr(r.run, '/repo')).state.kind).toBe('none')
		expect(r.ghCalls()).toBe(0)
	})

	it('never asks gh on the repository default branch', async () => {
		const r = scripted({ branch: 'trunk', defaultBranch: 'origin/trunk', gh: OPEN })
		expect((await lookupPr(r.run, '/repo')).state.kind).toBe('none')
		expect(r.ghCalls()).toBe(0)
	})

	it('shows nothing outside a repository or on a detached head', async () => {
		const r = scripted({ branch: ghError('fatal: not a git repository'), gh: OPEN })
		expect((await lookupPr(r.run, '/tmp')).state.kind).toBe('none')
		expect(r.ghCalls()).toBe(0)
	})

	it('names a missing gh', async () => {
		const r = scripted({ branch: 'f', gh: spawnError('ENOENT') })
		expect((await lookupPr(r.run, '/repo')).state).toEqual({
			kind: 'notice',
			text: GH_MISSING_NOTICE,
		})
	})

	it('names a signed-out gh', async () => {
		const r = scripted({
			branch: 'f',
			gh: ghError('To get started with GitHub CLI, please run:  gh auth login'),
		})
		expect((await lookupPr(r.run, '/repo')).state).toEqual({
			kind: 'notice',
			text: GH_SIGNED_OUT_NOTICE,
		})
	})

	it('shows nothing when the branch has no pull request, and nothing (but a failure) for anything else', async () => {
		const none = scripted({
			branch: 'f',
			gh: ghError('no pull requests found for branch "f"'),
		})
		expect(await lookupPr(none.run, '/repo')).toMatchObject({
			state: { kind: 'none' },
			failed: false,
		})
		const odd = scripted({ branch: 'f', gh: ghError('HTTP 502: bad gateway') })
		expect(await lookupPr(odd.run, '/repo')).toMatchObject({
			state: { kind: 'none' },
			failed: true,
		})
		const timedOut = scripted({ branch: 'f', gh: spawnError('ETIMEDOUT') })
		expect(await lookupPr(timedOut.run, '/repo')).toMatchObject({ failed: true })
	})
})

describe('the poll ladder', () => {
	it('waits longer the longer the person has been away', () => {
		const SEC = 1000
		expect(idleDelayMs(5 * SEC)).toBe(90 * SEC)
		expect(idleDelayMs(2 * 60 * SEC)).toBe(180 * SEC)
		expect(idleDelayMs(10 * 60 * SEC)).toBe(600 * SEC)
		expect(idleDelayMs(2 * 3600 * SEC)).toBe(1800 * SEC)
	})

	it('stretches for an answer that keeps coming back the same, and for repeated failures', () => {
		const base = { idleForMs: 0, unchangedStreak: 0, failureStreak: 0 }
		expect(nextDelayMs(base)).toBe(90_000)
		expect(nextDelayMs({ ...base, unchangedStreak: 2 })).toBe(300_000)
		expect(nextDelayMs({ ...base, unchangedStreak: 9 })).toBe(1_800_000)
		expect(nextDelayMs({ ...base, failureStreak: 3 })).toBe(240_000)
		expect(nextDelayMs({ ...base, idleForMs: 3600_000, failureStreak: 1 })).toBe(1_800_000)
	})
})

describe('PrPoller', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	function make(script: Script) {
		const r = scripted(script)
		const seen: PrFooterState[] = []
		const poller = new PrPoller({
			cwd: '/repo',
			run: r.run,
			onChange: (s) => seen.push(s),
			startDelayMs: 500,
		})
		return { r, seen, poller }
	}

	it('does nothing before start and nothing at all until the start delay has passed', async () => {
		const { r, poller } = make({ branch: 'f', gh: OPEN })
		expect(r.calls).toEqual([])
		poller.start()
		await vi.advanceTimersByTimeAsync(499)
		expect(r.calls).toEqual([])
		await vi.advanceTimersByTimeAsync(1)
		expect(r.ghCalls()).toBe(1)
		poller.stop()
	})

	it('reports a change once and then re-polls on the ladder', async () => {
		const { r, seen, poller } = make({ branch: 'f', gh: OPEN })
		poller.start()
		await vi.advanceTimersByTimeAsync(500)
		expect(seen.map((s) => s.kind)).toEqual(['pr'])
		await vi.advanceTimersByTimeAsync(89_999)
		expect(r.ghCalls()).toBe(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(r.ghCalls()).toBe(2)
		// Same answer again: no second report, and the next wait is longer.
		expect(seen).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(90_000)
		expect(r.ghCalls()).toBe(2)
		poller.stop()
	})

	it('runs nothing while paused, and looks again as soon as the turn ends', async () => {
		const { r, seen, poller } = make({ branch: 'f', gh: OPEN })
		poller.start()
		await vi.advanceTimersByTimeAsync(500)
		poller.setPaused(true)
		await vi.advanceTimersByTimeAsync(10 * 60_000)
		expect(r.ghCalls()).toBe(1)
		r.set({ branch: 'g', gh: ghError('no pull requests found for branch "g"') })
		poller.setPaused(false)
		await vi.advanceTimersByTimeAsync(0)
		expect(r.ghCalls()).toBe(2)
		expect(seen.map((s) => s.kind)).toEqual(['pr', 'none'])
		poller.stop()
	})

	it('does not start at all when it begins paused', async () => {
		const { r, poller } = make({ branch: 'f', gh: OPEN })
		poller.setPaused(true)
		poller.start()
		await vi.advanceTimersByTimeAsync(60 * 60_000)
		expect(r.calls).toEqual([])
		poller.stop()
	})

	it('survives a failing gh and says nothing about it', async () => {
		const { seen, poller } = make({ branch: 'f', gh: ghError('HTTP 500') })
		poller.start()
		await vi.advanceTimersByTimeAsync(500)
		expect(seen).toEqual([])
		poller.stop()
	})

	it('stops cleanly', async () => {
		const { r, poller } = make({ branch: 'f', gh: OPEN })
		poller.start()
		poller.stop()
		await vi.advanceTimersByTimeAsync(60 * 60_000)
		expect(r.calls).toEqual([])
	})
})
