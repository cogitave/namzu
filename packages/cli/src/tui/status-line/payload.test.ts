import { describe, expect, it } from 'vitest'

import { buildStatusLinePayload } from './payload.js'

const base = {
	sessionId: 'sess-1',
	cwd: '/work/app',
	projectDir: '/work',
	addedDirs: ['/data'],
	model: 'claude-sonnet-4-5',
	version: '9.9.9',
	totalCostUsd: 0.25,
	sessionStartedAt: 1_000,
	now: 4_500,
} as const

describe('buildStatusLinePayload', () => {
	it('names the fields a fresh session knows', () => {
		expect(buildStatusLinePayload(base)).toEqual({
			hook_event_name: 'StatusLine',
			session_id: 'sess-1',
			cwd: '/work/app',
			model: { id: 'claude-sonnet-4-5', display_name: 'claude-sonnet-4-5' },
			workspace: {
				current_dir: '/work/app',
				project_dir: '/work',
				added_dirs: ['/data'],
			},
			version: '9.9.9',
			cost: { total_cost_usd: 0.25, total_duration_ms: 3_500 },
		})
	})

	it('adds the context window, rounded and clamped, once a turn has reported it', () => {
		const payload = buildStatusLinePayload({
			...base,
			context: { tokens: 51_000, windowTokens: 200_000 },
		})
		expect(payload.context_window).toEqual({
			total_input_tokens: 51_000,
			context_window_size: 200_000,
			used_percentage: 26,
			remaining_percentage: 74,
		})
		expect(payload.exceeds_200k_tokens).toBe(false)
		const over = buildStatusLinePayload({
			...base,
			context: { tokens: 300_000, windowTokens: 200_000 },
		})
		expect(over.context_window).toMatchObject({
			used_percentage: 100,
			remaining_percentage: 0,
		})
		expect(over.exceeds_200k_tokens).toBe(true)
	})

	it('carries effort, agent, permission mode, worktree, repo and the pull request', () => {
		const payload = buildStatusLinePayload({
			...base,
			effort: 'high',
			agentName: 'Reviewer',
			permissionMode: 'accept-edits',
			sessionName: 'Fix login',
			gitWorktree: 'feature-x',
			repo: { host: 'github.com', owner: 'cogitave', name: 'namzu' },
			pr: {
				kind: 'pr',
				number: 592,
				url: 'https://github.com/cogitave/namzu/pull/592',
				review: 'changes',
			},
		})
		expect(payload).toMatchObject({
			effort: { level: 'high' },
			agent: { name: 'Reviewer' },
			permission_mode: 'accept-edits',
			session_name: 'Fix login',
			workspace: {
				git_worktree: 'feature-x',
				repo: { host: 'github.com', owner: 'cogitave', name: 'namzu' },
			},
			pr: {
				number: 592,
				url: 'https://github.com/cogitave/namzu/pull/592',
				review_state: 'changes_requested',
			},
		})
	})

	it('leaves out a merged pull request review, a footer notice and every fact it lacks', () => {
		const merged = buildStatusLinePayload({
			...base,
			pr: { kind: 'pr', number: 1, url: 'u', review: 'merged' },
		})
		expect(merged.pr).toEqual({ number: 1, url: 'u' })
		const notice = buildStatusLinePayload({
			...base,
			pr: { kind: 'notice', text: 'install gh' },
		})
		expect(notice).not.toHaveProperty('pr')
		for (const key of ['context_window', 'effort', 'agent', 'rate_limits', 'output_style', 'vim']) {
			expect(buildStatusLinePayload(base)).not.toHaveProperty(key)
		}
	})
})

describe('permission_mode', () => {
	it.each([
		['bypass', 'bypass'],
		['classify', 'auto'],
		['strict', 'strict'],
		['auto', 'unattended'],
	] as const)('names %s the way a person types it', (mode, word) => {
		const payload = buildStatusLinePayload({ ...base, permissionMode: mode })

		expect(payload.permission_mode).toBe(word)
	})
})
