/**
 * The pull request for the current branch, for the composer footer.
 *
 * The footer shows `PR #592` beside the mode when the branch has an open pull
 * request. The answer comes from the `gh` command line tool, which already
 * holds the person's sign-in; nothing here reads a token or calls an API.
 *
 * Everything in this file runs off the render path. The footer reads the last
 * known answer; a poller refreshes it in the background, with a timeout on
 * every child process, and a failure never reaches the screen as anything
 * more than one of two short, dim hints (`gh` missing, `gh` signed out).
 *
 * ## When it asks
 *
 * - Once shortly after start, never during it.
 * - Again when the branch changes (checked each time a turn ends, which is
 *   when an agent is likely to have switched it).
 * - Then on a slow ladder: the longer the person has been away, the longer
 *   the wait, and an answer that keeps coming back the same, or a failure
 *   that keeps repeating, stretches it further.
 * - Never while a turn is running: the answer cannot matter yet, and the
 *   machine is busy.
 *
 * The caller decides whether to run it at all; print and exec modes never
 * mount the interactive screen, so they never reach this file.
 */

import { execFile } from 'node:child_process'

export type PrReview = 'approved' | 'changes' | 'pending' | 'merged' | 'draft'

export interface PrInfo {
	readonly number: number
	readonly url: string
	readonly review: PrReview
}

/** What the footer shows: nothing, a pull request, or one dim hint. */
export type PrFooterState =
	| { readonly kind: 'none' }
	| ({ readonly kind: 'pr' } & PrInfo)
	| { readonly kind: 'notice'; readonly text: string }

export const PR_NONE: PrFooterState = { kind: 'none' }
export const GH_MISSING_NOTICE = 'install gh for PR status'
export const GH_SIGNED_OUT_NOTICE = 'gh auth login for PR status'

export interface RunOptions {
	readonly cwd: string
	readonly timeoutMs: number
}

/** Runs a program and resolves with its stdout; rejects with the spawn error (`code`, `stderr`). */
export type RunCommand = (
	file: string,
	args: readonly string[],
	options: RunOptions,
) => Promise<{ readonly stdout: string }>

export const PR_COMMAND_TIMEOUT_MS = 5_000

export const runCommand: RunCommand = (file, args, options) =>
	new Promise((resolve, reject) => {
		execFile(
			file,
			[...args],
			{
				cwd: options.cwd,
				timeout: options.timeoutMs,
				windowsHide: true,
				maxBuffer: 1024 * 1024,
				// Never let a credential prompt wait on a terminal that is not ours.
				env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
			},
			(error, stdout, stderr) => {
				if (error) reject(Object.assign(error, { stderr: String(stderr ?? '') }))
				else resolve({ stdout: String(stdout) })
			},
		)
	})

const MAIN_BRANCHES = new Set(['main', 'master'])

/** The checked-out branch, or null when detached, outside a repository, or git is unavailable. */
export async function readBranch(run: RunCommand, cwd: string): Promise<string | null> {
	try {
		const { stdout } = await run('git', ['symbolic-ref', '--short', 'HEAD'], {
			cwd,
			timeoutMs: PR_COMMAND_TIMEOUT_MS,
		})
		const branch = stdout.trim()
		return branch.length > 0 ? branch : null
	} catch {
		return null
	}
}

/** The repository's default branch as the remote names it, when it is known locally. */
async function readDefaultBranch(run: RunCommand, cwd: string): Promise<string | null> {
	try {
		const { stdout } = await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
			cwd,
			timeoutMs: PR_COMMAND_TIMEOUT_MS,
		})
		const name = stdout.trim().replace(/^origin\//, '')
		return name.length > 0 ? name : null
	} catch {
		return null
	}
}

const REVIEW_BY_DECISION: Readonly<Record<string, PrReview>> = {
	APPROVED: 'approved',
	CHANGES_REQUESTED: 'changes',
}

/** Read `gh pr view --json number,url,state,isDraft,reviewDecision`. Null when it is not a usable pull request. */
export function parsePrView(stdout: string): PrInfo | null {
	let raw: unknown
	try {
		raw = JSON.parse(stdout)
	} catch {
		return null
	}
	if (typeof raw !== 'object' || raw === null) return null
	const value = raw as Record<string, unknown>
	const number = value.number
	const url = value.url
	if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null
	if (typeof url !== 'string') return null
	const state = typeof value.state === 'string' ? value.state.toUpperCase() : 'OPEN'
	// A closed, unmerged pull request is not worth a footer item.
	if (state === 'CLOSED') return null
	let review: PrReview
	if (state === 'MERGED') review = 'merged'
	else if (value.isDraft === true) review = 'draft'
	else review = REVIEW_BY_DECISION[String(value.reviewDecision ?? '')] ?? 'pending'
	return { number, url, review }
}

type Failure = 'missing' | 'signed-out' | 'no-pr' | 'other'

function classifyFailure(error: unknown): Failure {
	const err = error as { code?: unknown; stderr?: unknown; message?: unknown }
	if (err?.code === 'ENOENT') return 'missing'
	const text = `${String(err?.stderr ?? '')} ${String(err?.message ?? '')}`.toLowerCase()
	if (text.includes('no pull requests found')) return 'no-pr'
	if (
		text.includes('gh auth login') ||
		text.includes('not logged in') ||
		text.includes('authentication') ||
		text.includes('gh_token')
	) {
		return 'signed-out'
	}
	return 'other'
}

export interface PrLookup {
	readonly branch: string | null
	readonly state: PrFooterState
	/** True when the lookup failed in a way that should stretch the poll interval. */
	readonly failed: boolean
}

/** One complete lookup: branch, then `gh`. Never rejects. */
export async function lookupPr(run: RunCommand, cwd: string): Promise<PrLookup> {
	const branch = await readBranch(run, cwd)
	if (branch === null || MAIN_BRANCHES.has(branch)) return { branch, state: PR_NONE, failed: false }
	if (branch === (await readDefaultBranch(run, cwd)))
		return { branch, state: PR_NONE, failed: false }
	try {
		const { stdout } = await run(
			'gh',
			['pr', 'view', '--json', 'number,url,state,isDraft,reviewDecision'],
			{ cwd, timeoutMs: PR_COMMAND_TIMEOUT_MS },
		)
		const info = parsePrView(stdout)
		return { branch, state: info ? { kind: 'pr', ...info } : PR_NONE, failed: false }
	} catch (error) {
		switch (classifyFailure(error)) {
			case 'missing':
				return { branch, state: { kind: 'notice', text: GH_MISSING_NOTICE }, failed: false }
			case 'signed-out':
				return { branch, state: { kind: 'notice', text: GH_SIGNED_OUT_NOTICE }, failed: false }
			case 'no-pr':
				return { branch, state: PR_NONE, failed: false }
			default:
				return { branch, state: PR_NONE, failed: true }
		}
	}
}

const SECOND = 1_000
const MINUTE = 60 * SECOND

/** How long to wait, by how long the person has been away. */
export function idleDelayMs(idleForMs: number): number {
	if (idleForMs < 30 * SECOND) return 90 * SECOND
	if (idleForMs < 5 * MINUTE) return 3 * MINUTE
	if (idleForMs < 30 * MINUTE) return 10 * MINUTE
	return 30 * MINUTE
}

const UNCHANGED_LADDER_MS = [90 * SECOND, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE]
const FAILURE_LADDER_MS = [90 * SECOND, 2 * MINUTE, 4 * MINUTE, 5 * MINUTE]

/** The next wait: the longest of the three ladders. */
export function nextDelayMs(input: {
	readonly idleForMs: number
	readonly unchangedStreak: number
	readonly failureStreak: number
}): number {
	const rung = (ladder: readonly number[], streak: number): number =>
		streak <= 0 ? 0 : (ladder[Math.min(streak, ladder.length) - 1] ?? 0)
	return Math.max(
		idleDelayMs(input.idleForMs),
		rung(UNCHANGED_LADDER_MS, input.unchangedStreak),
		rung(FAILURE_LADDER_MS, input.failureStreak),
	)
}

export interface PrPollerOptions {
	readonly cwd: string
	readonly run?: RunCommand
	readonly onChange: (state: PrFooterState) => void
	readonly now?: () => number
	readonly setTimer?: (fn: () => void, ms: number) => unknown
	readonly clearTimer?: (handle: unknown) => void
	/** Wait before the first lookup, so it stays clear of startup. */
	readonly startDelayMs?: number
}

export class PrPoller {
	private readonly run: RunCommand
	private readonly now: () => number
	private readonly setTimer: (fn: () => void, ms: number) => unknown
	private readonly clearTimer: (handle: unknown) => void
	private timer: unknown = null
	private paused = false
	private stopped = true
	private inFlight = false
	private lastActivity: number
	private lastBranch: string | null | undefined
	private last: PrFooterState = PR_NONE
	private unchangedStreak = 0
	private failureStreak = 0

	constructor(private readonly options: PrPollerOptions) {
		this.run = options.run ?? runCommand
		this.now = options.now ?? Date.now
		this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
		this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never))
		this.lastActivity = this.now()
	}

	start(): void {
		if (!this.stopped) return
		this.stopped = false
		this.schedule(this.options.startDelayMs ?? 500)
	}

	stop(): void {
		this.stopped = true
		this.clearPending()
	}

	/** The person did something; the ladder starts again from its fastest rung. */
	touch(): void {
		this.lastActivity = this.now()
	}

	/** True while a turn runs: no lookup starts, and a waiting one is cancelled. */
	setPaused(paused: boolean): void {
		if (this.paused === paused) return
		this.paused = paused
		if (this.stopped) return
		if (paused) {
			this.clearPending()
			return
		}
		// The turn ended. An agent may have switched branches, so look now.
		this.schedule(0)
	}

	private clearPending(): void {
		if (this.timer !== null) this.clearTimer(this.timer)
		this.timer = null
	}

	private schedule(ms: number): void {
		this.clearPending()
		if (this.stopped || this.paused) return
		this.timer = this.setTimer(() => {
			this.timer = null
			void this.tick()
		}, ms)
	}

	private async tick(): Promise<void> {
		if (this.stopped || this.paused || this.inFlight) return
		this.inFlight = true
		let result: PrLookup
		try {
			result = await lookupPr(this.run, this.options.cwd)
		} finally {
			this.inFlight = false
		}
		// A turn may have started, or the footer gone, while the child ran.
		if (this.stopped) return
		const branchChanged = this.lastBranch !== undefined && result.branch !== this.lastBranch
		this.lastBranch = result.branch
		const same = sameState(this.last, result.state)
		this.unchangedStreak = same && !branchChanged ? this.unchangedStreak + 1 : 0
		this.failureStreak = result.failed ? this.failureStreak + 1 : 0
		if (!same) {
			this.last = result.state
			this.options.onChange(result.state)
		}
		this.schedule(
			nextDelayMs({
				idleForMs: this.now() - this.lastActivity,
				unchangedStreak: this.unchangedStreak,
				failureStreak: this.failureStreak,
			}),
		)
	}
}

export function sameState(a: PrFooterState, b: PrFooterState): boolean {
	if (a.kind !== b.kind) return false
	if (a.kind === 'pr' && b.kind === 'pr') {
		return a.number === b.number && a.url === b.url && a.review === b.review
	}
	if (a.kind === 'notice' && b.kind === 'notice') return a.text === b.text
	return true
}
