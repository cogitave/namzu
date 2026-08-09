/**
 * `createCommandGate` — the reviewer nothing shipped supplied.
 *
 * The test that matters here is NOT "the gate ran". It is the one that
 * proves the gate did **not** run: a failure, then an answer that changed
 * nothing, and the command must not be executed a second time. A suite that
 * only asserted rejection would pass against a gate with no detector in it
 * at all, which is the version that spends a run's whole budget re-learning
 * one failure.
 *
 * Its guard is the test immediately after: touch a file and the command MUST
 * run again. Without that pair, a detector that never re-runs anything reads
 * as correct.
 */

import { describe, expect, it, vi } from 'vitest'

import type { CommandResult } from '../../types/execution/index.js'
import type { RunId } from '../../types/ids/index.js'
import type { AnswerReview, AnswerReviewContext } from '../../types/run/answer-review.js'
import { clipOutput, createCommandGate } from '../command-gate.js'

const CONTEXT: AnswerReviewContext = { runId: 'run_x' as RunId, iteration: 1, messages: [] }

function result(over: Partial<CommandResult> = {}): CommandResult {
	return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, ...over }
}

/** A workspace whose fingerprint the test moves by hand. */
function tree(initial = 'fp-1') {
	let value: string | null = initial
	return {
		fingerprint: async () => value,
		touch: (next: string) => {
			value = next
		},
		unreadable: () => {
			value = null
		},
	}
}

function reviewed(gate: ReturnType<typeof createCommandGate>): Promise<AnswerReview> {
	return Promise.resolve(gate('an answer', CONTEXT))
}

describe('a gate whose command passes', () => {
	it('accepts, and runs each command in the order it was given', async () => {
		const seen: string[] = []
		const exec = vi.fn(async (command: string) => {
			seen.push(command)
			return result()
		})
		const gate = createCommandGate({
			commands: ['pnpm typecheck', 'pnpm test'],
			cwd: '/w',
			exec,
			fingerprint: tree().fingerprint,
		})

		await expect(reviewed(gate)).resolves.toEqual({ accept: true })
		expect(seen).toEqual(['pnpm typecheck', 'pnpm test'])
	})

	it('stops at the first failure instead of reporting every downstream one', async () => {
		const exec = vi.fn(async (command: string) =>
			command === 'pnpm typecheck' ? result({ exitCode: 2, stderr: 'TS2322' }) : result(),
		)
		const gate = createCommandGate({
			commands: ['pnpm typecheck', 'pnpm test'],
			cwd: '/w',
			exec,
			fingerprint: tree().fingerprint,
		})

		const review = await reviewed(gate)
		expect(review.accept).toBe(false)
		// A type error makes the test output noise about the same cause, and
		// handing the model both invites it to fix the symptom.
		expect(exec).toHaveBeenCalledTimes(1)
	})
})

describe('an answer that changed nothing', () => {
	it('does not re-run the command, says so, and still spends the attempt', async () => {
		const workspace = tree()
		const exec = vi.fn(async () => result({ exitCode: 1, stdout: 'FAIL src/a.test.ts' }))
		const gate = createCommandGate({
			commands: ['pnpm test'],
			cwd: '/w',
			exec,
			fingerprint: workspace.fingerprint,
		})

		const first = await reviewed(gate)
		expect(first.accept).toBe(false)
		expect(exec).toHaveBeenCalledTimes(1)

		// The model answers again having edited nothing.
		const second = await reviewed(gate)

		expect(second.accept).toBe(false)
		// EXACTLY ONCE across both reviews. This is the whole point: a gate
		// without the detector runs the suite again to produce a failure it has
		// already reported character for character, and does it once per
		// remaining attempt.
		expect(exec).toHaveBeenCalledTimes(1)
		// And the feedback is DIFFERENT. Repeating the failure would hand the
		// model the same prompt that just failed to help it; naming the real
		// problem is a different instruction.
		if (second.accept) throw new Error('unreachable')
		expect(second.feedback).toContain('was NOT re-run')
		expect(second.feedback).toContain('identical')
		// The attempt still advanced. Skipping the command is a saving, not a
		// pardon — an answer that changed nothing has been rejected, and a run
		// whose budget never saw it would loop forever for free.
		expect(second.feedback).toContain('attempt 2')
		if (first.accept) throw new Error('unreachable')
		expect(first.feedback).toContain('attempt 1')
	})

	it('runs the command again once a file is touched', async () => {
		const workspace = tree()
		const exec = vi.fn(async () => result({ exitCode: 1, stdout: 'still failing' }))
		const gate = createCommandGate({
			commands: ['pnpm test'],
			cwd: '/w',
			exec,
			fingerprint: workspace.fingerprint,
		})

		await reviewed(gate)
		workspace.touch('fp-2')
		const second = await reviewed(gate)

		// The guard on the test above. A detector that never re-runs anything
		// would pass that one and fail this, and a gate that stopped verifying
		// after its first failure is worse than no gate: it reports a red build
		// as settled work.
		expect(exec).toHaveBeenCalledTimes(2)
		if (second.accept) throw new Error('unreachable')
		expect(second.feedback).not.toContain('was NOT re-run')
	})

	it('accepts once the re-run passes', async () => {
		const workspace = tree()
		let failing = true
		const exec = vi.fn(async () => (failing ? result({ exitCode: 1 }) : result()))
		const gate = createCommandGate({
			commands: ['pnpm test'],
			cwd: '/w',
			exec,
			fingerprint: workspace.fingerprint,
		})

		await reviewed(gate)
		failing = false
		workspace.touch('fp-2')
		await expect(reviewed(gate)).resolves.toEqual({ accept: true })
	})

	it('re-runs when the workspace cannot be fingerprinted at all', async () => {
		const workspace = tree()
		const exec = vi.fn(async () => result({ exitCode: 1 }))
		const gate = createCommandGate({
			commands: ['pnpm test'],
			cwd: '/w',
			exec,
			fingerprint: workspace.fingerprint,
		})

		await reviewed(gate)
		workspace.unreadable()
		await reviewed(gate)

		// Failing open, on the cheap side. A wrong `null` costs one execution;
		// a wrong MATCH is a verification that silently did not happen and a
		// model told to edit something it already edited.
		expect(exec).toHaveBeenCalledTimes(2)
	})

	it('re-runs when the failure itself could not be fingerprinted', async () => {
		let value: string | null = null
		const exec = vi.fn(async () => result({ exitCode: 1 }))
		const gate = createCommandGate({
			commands: ['pnpm test'],
			cwd: '/w',
			exec,
			fingerprint: async () => value,
		})

		await reviewed(gate)
		// The snapshot at the failure was `null`, so there is nothing to
		// compare a later fingerprint against — even a readable one.
		value = 'fp-now'
		await reviewed(gate)
		expect(exec).toHaveBeenCalledTimes(2)
	})
})

describe('what the model is told', () => {
	it('names the command, the attempt, the exit code and the output', async () => {
		const exec = vi.fn(async () =>
			result({ exitCode: 3, stdout: 'expected 1 to be 2', stderr: 'at a.test.ts:7' }),
		)
		const gate = createCommandGate({
			commands: ['pnpm vitest run'],
			cwd: '/w',
			exec,
			fingerprint: tree().fingerprint,
		})

		const review = await reviewed(gate)
		if (review.accept) throw new Error('unreachable')
		// Prose, and specific. "Rejected" gets a paraphrase; "the build fails
		// with X" gets a fix.
		expect(review.feedback).toContain('pnpm vitest run')
		expect(review.feedback).toContain('attempt 1')
		expect(review.feedback).toContain('exit 3')
		expect(review.feedback).toContain('expected 1 to be 2')
		expect(review.feedback).toContain('at a.test.ts:7')
	})

	it('keeps both ends of a long output', () => {
		const text = `HEAD${'x'.repeat(500)}TAIL`
		const clipped = clipOutput(text, 100)
		// A compiler names the file at the top and a test runner names the
		// failure at the bottom. A gate that only kept one end is useless for
		// one of them.
		expect(clipped.startsWith('HEAD')).toBe(true)
		expect(clipped.endsWith('TAIL')).toBe(true)
		expect(clipped).toContain('characters omitted')
		expect(clipped.length).toBeLessThan(text.length)
	})

	it('leaves a short output alone', () => {
		expect(clipOutput('  all good\n\n', 100)).toBe('  all good')
	})
})

describe('the bound', () => {
	it('stops executing after its retries and still refuses to accept', async () => {
		const workspace = tree()
		let n = 0
		const exec = vi.fn(async () => {
			n += 1
			return result({ exitCode: 1, stdout: `fail ${n}` })
		})
		const gate = createCommandGate({
			commands: ['pnpm test'],
			cwd: '/w',
			exec,
			maxRetries: 2,
			fingerprint: workspace.fingerprint,
		})

		await reviewed(gate)
		workspace.touch('fp-2')
		await reviewed(gate)
		workspace.touch('fp-3')
		const third = await reviewed(gate)

		expect(exec).toHaveBeenCalledTimes(2)
		// It does NOT accept. An answer that never passed the gate has not
		// passed it, and a reviewer that gave up by accepting would hand back a
		// green run over a red build — the exact outcome a gate exists to
		// prevent. What ends the run is the kernel's rejection budget.
		expect(third.accept).toBe(false)
		if (third.accept) throw new Error('unreachable')
		expect(third.feedback).toContain('spent its 2 attempts')
	})
})
