import { describe, expect, it } from 'vitest'

import { isReviewExempt } from '../../runtime/query/review-policy.js'
import { batchNeedsReview } from '../../runtime/query/review-policy.js'
import { BashTool } from '../builtins/bash.js'
import { isTrustedReadOnly } from '../trusted-read-only.js'

const registry = {
	get: (name: string) => (name === 'bash' ? BashTool : undefined),
	sourceOf: () => undefined,
}
const exempt = (name: string, input: unknown) =>
	isReviewExempt(registry as unknown as Parameters<typeof isReviewExempt>[0], name, input)

describe('the bash tool reports whether a call only reads', () => {
	it('is read-only and safe beside other reads for a vetted line', () => {
		const input = { command: 'git status' }
		expect(BashTool.isReadOnly?.(input as never)).toBe(true)
		expect(BashTool.isConcurrencySafe?.(input as never)).toBe(true)
		expect(isTrustedReadOnly(BashTool as never, input)).toBe(true)
	})

	it('is neither for a line that writes, and runs alone', () => {
		const input = { command: 'git commit -m x' }
		expect(BashTool.isReadOnly?.(input as never)).toBe(false)
		expect(BashTool.isConcurrencySafe?.(input as never)).toBe(false)
	})

	it('is neither for a background job or a sandbox escape, whatever the line says', () => {
		expect(
			BashTool.isReadOnly?.({
				command: 'ls',
				run_in_background: true,
			} as never),
		).toBe(false)
		expect(
			BashTool.isReadOnly?.({
				command: 'ls',
				dangerously_disable_sandbox: true,
			} as never),
		).toBe(false)
		expect(
			BashTool.isConcurrencySafe?.({
				command: 'ls',
				run_in_background: true,
			} as never),
		).toBe(false)
	})
})

describe('a read-only shell call is not asked about, unless it reads outside the roots', () => {
	it('runs without review', () => {
		expect(exempt('bash', { command: 'ls -la' })).toBe(true)
		expect(exempt('bash', { command: 'git diff --stat' })).toBe(true)
		expect(exempt('bash', { command: 'npm test' })).toBe(false)
		expect(exempt('bash', { command: 'git diff --output=x' })).toBe(false)
	})

	it('is still reviewed when the safety floor found an escalation', () => {
		const calls = [
			{
				id: '1',
				name: 'bash',
				input: { command: 'cat /etc/hosts' },
				escalation: { outsidePaths: ['/etc/hosts'] },
			},
		]

		expect(batchNeedsReview(calls as never, exempt)).toBe(true)
		expect(
			batchNeedsReview(
				[{ id: '2', name: 'bash', input: { command: 'cat a.txt' } }] as never,
				exempt,
			),
		).toBe(false)
	})
})
