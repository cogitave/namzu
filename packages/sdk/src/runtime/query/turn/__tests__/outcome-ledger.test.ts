import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TurnOutcomeConfig } from '../../../../types/session/outcome.js'
import type { ToolFacts } from '../../../../types/tool/index.js'
import { type OutcomeCall, OutcomeLedger } from '../outcome-ledger.js'

afterEach(() => {
	vi.useRealTimers()
})

function bash(command: string, facts: Partial<Extract<ToolFacts, { kind: 'command' }>> = {}) {
	return {
		toolName: 'bash',
		input: { command },
		facts: { kind: 'command', command, exitCode: 0, ...facts },
	} satisfies OutcomeCall
}

function failedBash(command: string, exitCode = 1): OutcomeCall {
	return { ...bash(command, { exitCode }), isError: true }
}

function edit(path: string): OutcomeCall {
	return {
		toolName: 'edit',
		input: { path },
		facts: { kind: 'edit', path, replacements: 1 },
	}
}

function read(path: string): OutcomeCall {
	return { toolName: 'read', input: { path }, readOnly: true }
}

/** A workspace the test moves by hand, and a detector that reports it. */
function workspace(initial: string | null = 'a') {
	const state = { fingerprint: initial as string | null, asked: 0 }
	const config: TurnOutcomeConfig = {
		detectChanges: async () => {
			state.asked += 1
			return state.fingerprint
		},
	}
	return { state, config }
}

/** Run steps against a ledger the way the loop does: `before` then, once the calls ran, `observe`. */
async function turn(ledger: OutcomeLedger, steps: readonly (readonly OutcomeCall[])[]) {
	let step = 0
	for (const calls of steps) {
		step += 1
		await ledger.before(calls)
		await ledger.observe(step, calls)
	}
	return ledger.finish()
}

describe('the outcome of a turn, by its own calls', () => {
	it('a turn that read and changed nothing is unchanged', async () => {
		const outcome = await turn(new OutcomeLedger(), [[read('a.ts')]])
		expect(outcome).toEqual({
			verdict: 'unchanged',
			basis: 'calls',
			changes: { total: 0, paths: [], outsideKnownTools: false },
			checks: [],
		})
	})

	it('a change nothing checked is unchecked, and names its paths once', async () => {
		const outcome = await turn(new OutcomeLedger(), [[edit('a.ts'), edit('a.ts'), edit('b.ts')]])
		expect(outcome?.verdict).toBe('unchecked')
		expect(outcome?.changes).toEqual({
			total: 2,
			paths: ['a.ts', 'b.ts'],
			outsideKnownTools: false,
		})
	})

	it('a write that failed, was skipped or left the file as it was changed nothing', async () => {
		const outcome = await turn(new OutcomeLedger(), [
			[
				{ ...edit('a.ts'), isError: true },
				{ ...edit('b.ts'), skipped: true },
				{
					toolName: 'write',
					input: { path: 'c.ts' },
					facts: { kind: 'write', path: 'c.ts', operation: 'unchanged' },
				},
			],
		])
		expect(outcome?.verdict).toBe('unchanged')
	})

	it('a check that passed after the last change makes it checked', async () => {
		const outcome = await turn(new OutcomeLedger(), [[edit('a.ts')], [bash('pnpm test')]])
		expect(outcome?.verdict).toBe('checked')
		expect(outcome?.checks).toEqual([
			{ command: 'pnpm test', step: 2, result: 'passed', exitCode: 0, fresh: true },
		])
	})

	it('a change after the last pass makes it stale', async () => {
		const outcome = await turn(new OutcomeLedger(), [
			[edit('a.ts')],
			[bash('pnpm test')],
			[edit('b.ts')],
		])
		expect(outcome?.verdict).toBe('stale')
		expect(outcome?.checks[0]?.fresh).toBe(false)
	})

	it('a shell command after the last pass leaves it unknown, not stale and not checked', async () => {
		const outcome = await turn(new OutcomeLedger(), [
			[edit('a.ts')],
			[bash('pnpm test')],
			[bash('sed -i s/a/b/ a.ts')],
		])
		expect(outcome?.verdict).toBe('inconclusive')
		expect(outcome?.checks[0]).not.toHaveProperty('fresh')
	})

	it('a read-only command after the last pass does not disturb it', async () => {
		const outcome = await turn(new OutcomeLedger(), [
			[edit('a.ts')],
			[bash('pnpm test')],
			[bash('git status'), read('a.ts')],
		])
		expect(outcome?.verdict).toBe('checked')
	})

	it('a check that failed is failing, changed or not', async () => {
		const outcome = await turn(new OutcomeLedger(), [[failedBash('pnpm test')]])
		expect(outcome?.verdict).toBe('failing')
		expect(outcome?.checks[0]).toMatchObject({ result: 'failed', exitCode: 1 })
	})

	it('failing wins over a different check that passed later', async () => {
		const outcome = await turn(new OutcomeLedger(), [
			[edit('a.ts')],
			[failedBash('pnpm test')],
			[bash('pnpm lint')],
		])
		expect(outcome?.verdict).toBe('failing')
		expect(outcome?.checks.map((c) => c.result)).toEqual(['failed', 'passed'])
	})

	it('a failed check that was run again and passed is no longer failing', async () => {
		const outcome = await turn(new OutcomeLedger(), [
			[edit('a.ts')],
			[failedBash('pnpm test')],
			[edit('a.ts')],
			[bash('pnpm  test')],
		])
		expect(outcome?.verdict).toBe('checked')
		expect(outcome?.checks).toHaveLength(1)
		expect(outcome?.checks[0]?.step).toBe(4)
	})

	it('a check that passed and was then run again and failed is failing', async () => {
		const outcome = await turn(new OutcomeLedger(), [
			[edit('a.ts')],
			[bash('pnpm test')],
			[failedBash('pnpm test')],
		])
		expect(outcome?.verdict).toBe('failing')
	})

	it('a refused check is a failed one', async () => {
		const outcome = await turn(new OutcomeLedger(), [
			[edit('a.ts')],
			[
				{
					toolName: 'bash',
					input: { command: 'pnpm test' },
					isError: true,
					facts: { kind: 'failure', reason: 'permission_denied', subject: 'bash' },
				},
			],
		])
		expect(outcome?.verdict).toBe('failing')
	})
})

describe('a command line that lets something else decide the exit status never passes', () => {
	it.each([
		'pnpm test | tail -5',
		'pnpm test 2>&1 | tee out.log',
		'pnpm test; echo done',
		'pnpm test || true',
		'pnpm test &',
		'pnpm lint && pnpm test | tail',
		'(pnpm test)',
		'bash -c "pnpm test"',
		'! pnpm test',
		'echo start; pnpm test',
	])('%s', async (command) => {
		const outcome = await turn(new OutcomeLedger(), [[edit('a.ts')], [bash(command)]])
		expect(outcome?.checks[0]?.result).toBe('masked')
		expect(outcome?.verdict).toBe('inconclusive')
	})

	it.each([
		'cd pkg && pnpm test',
		'pnpm test 2>&1',
		'pnpm test > out.log',
		'CI=1 pnpm test && pnpm lint',
		'pnpm test;',
	])('%s passes on exit 0', async (command) => {
		const outcome = await turn(new OutcomeLedger(), [[edit('a.ts')], [bash(command)]])
		expect(outcome?.checks[0]?.result).toBe('passed')
		expect(outcome?.verdict).toBe('checked')
	})

	it('a masked run that exited non-zero is masked too, not failed', async () => {
		const outcome = await turn(new OutcomeLedger(), [
			[edit('a.ts')],
			[failedBash('pnpm test | tail -5')],
		])
		expect(outcome?.checks[0]?.result).toBe('masked')
	})
})

describe('a check whose answer was not seen', () => {
	it.each([
		['handed to a background job', { background: true as const, exitCode: undefined }],
		['continued', { continued: true as const, exitCode: undefined }],
		['timed out', { timedOut: true, exitCode: undefined }],
		['non-zero but its own answer', { exitCode: 1, exitNote: 'no matches' }],
	])('%s is unsettled', async (_name, facts) => {
		const outcome = await turn(new OutcomeLedger(), [[edit('a.ts')], [bash('pnpm test', facts)]])
		expect(outcome?.checks[0]?.result).toBe('unsettled')
		expect(outcome?.verdict).toBe('inconclusive')
	})

	it('a run with no typed record, and no error, is unsettled', async () => {
		const outcome = await turn(new OutcomeLedger(), [
			[edit('a.ts')],
			[{ toolName: 'bash', input: { command: 'pnpm test' } }],
		])
		expect(outcome?.checks[0]?.result).toBe('unsettled')
	})

	it('a run with no typed record and an error is failed', async () => {
		const outcome = await turn(new OutcomeLedger(), [
			[edit('a.ts')],
			[{ toolName: 'bash', input: { command: 'pnpm test' }, isError: true }],
		])
		expect(outcome?.checks[0]?.result).toBe('failed')
	})
})

describe('which commands are checks', () => {
	it('a line that only names a check to a command that prints it is not one', async () => {
		const outcome = await turn(new OutcomeLedger(), [
			[edit('a.ts')],
			[bash('echo "pnpm test"'), bash('grep -n "npm run lint" README.md')],
		])
		expect(outcome?.checks).toEqual([])
		expect(outcome?.verdict).toBe('unchecked')
	})

	it("a project's own script is one when the host names it", async () => {
		const ledger = new OutcomeLedger({ isCheck: (c) => c.includes('scripts/ci.sh') })
		const outcome = await turn(ledger, [[edit('a.ts')], [bash('./scripts/ci.sh')]])
		expect(outcome?.verdict).toBe('checked')
	})

	it('a host predicate that throws recognises nothing', async () => {
		const ledger = new OutcomeLedger({
			isCheck: () => {
				throw new Error('boom')
			},
		})
		const outcome = await turn(ledger, [[edit('a.ts')], [bash('./scripts/ci.sh')]])
		expect(outcome?.checks).toEqual([])
	})

	it('a hook-skipped check did not run', async () => {
		const outcome = await turn(new OutcomeLedger(), [
			[edit('a.ts')],
			[{ ...bash('pnpm test'), skipped: true }],
		])
		expect(outcome?.verdict).toBe('unchecked')
	})
})

describe('the record is bounded', () => {
	it('keeps 50 paths and says how many there were', async () => {
		const edits = Array.from({ length: 60 }, (_, i) => edit(`src/f${i}.ts`))
		const outcome = await turn(new OutcomeLedger(), [edits])
		expect(outcome?.changes.total).toBe(60)
		expect(outcome?.changes.paths).toHaveLength(50)
		expect(outcome?.changes.paths[0]).toBe('src/f0.ts')
	})

	it('keeps the latest 20 checks and says how many there were', async () => {
		const checks = Array.from({ length: 25 }, (_, i) => bash(`pnpm test -- f${i}`))
		const outcome = await turn(new OutcomeLedger(), [[edit('a.ts')], ...checks.map((c) => [c])])
		expect(outcome?.checks).toHaveLength(20)
		expect(outcome?.checksTotal).toBe(25)
		expect(outcome?.checks[19]?.command).toBe('pnpm test -- f24')
	})

	it('verdict counts a failing check the cut-off list dropped', async () => {
		const passes = Array.from({ length: 25 }, (_, i) => bash(`pnpm test -- f${i}`))
		const outcome = await turn(new OutcomeLedger(), [
			[failedBash('pnpm lint')],
			...passes.map((c) => [c]),
		])
		expect(outcome?.verdict).toBe('failing')
		expect(outcome?.checks.some((c) => c.command === 'pnpm lint')).toBe(false)
	})

	it('clips a long command and a long path', async () => {
		const long = `pnpm test -- ${'x'.repeat(600)}`
		const outcome = await turn(new OutcomeLedger(), [
			[edit(`${'d/'.repeat(300)}f.ts`)],
			[bash(long)],
		])
		expect(outcome?.checks[0]?.command.length).toBe(301)
		expect(outcome?.changes.paths[0]?.length).toBe(301)
	})
})

describe('with a detector, the workspace is what is compared', () => {
	it('never asks a detector in a turn of provably read-only calls', async () => {
		const { state, config } = workspace()
		const outcome = await turn(new OutcomeLedger(config), [[read('a.ts'), bash('git status')]])
		expect(state.asked).toBe(0)
		expect(outcome?.verdict).toBe('unchanged')
		expect(outcome?.basis).toBe('calls')
	})

	it('sees a change a shell command made, and says no write tool explains it', async () => {
		const { state, config } = workspace('a')
		const ledger = new OutcomeLedger(config)
		await ledger.before([bash('sed -i s/a/b/ a.ts')])
		state.fingerprint = 'b'
		await ledger.observe(1, [bash('sed -i s/a/b/ a.ts')])
		const outcome = await ledger.finish()
		expect(outcome?.basis).toBe('workspace')
		expect(outcome?.verdict).toBe('unchecked')
		expect(outcome?.changes).toEqual({ total: 0, paths: [], outsideKnownTools: true })
	})

	it('a workspace that is the same at the end as at the start is unchanged', async () => {
		const { config } = workspace('a')
		const outcome = await turn(new OutcomeLedger(config), [[bash('ls -la > /dev/null; mkdir x')]])
		expect(outcome?.verdict).toBe('unchanged')
		expect(outcome?.basis).toBe('workspace')
	})

	it('asks once before the first call that could change it, after each check, and once at the end', async () => {
		const { state, config } = workspace('a')
		const ledger = new OutcomeLedger(config)
		await ledger.before([read('a.ts')])
		expect(state.asked).toBe(0)
		await ledger.before([edit('a.ts')])
		expect(state.asked).toBe(1)
		state.fingerprint = 'b'
		await ledger.observe(2, [edit('a.ts')])
		expect(state.asked).toBe(1)
		await ledger.before([bash('pnpm test')])
		expect(state.asked).toBe(1)
		await ledger.observe(3, [bash('pnpm test')])
		expect(state.asked).toBe(2)
		await ledger.finish()
		expect(state.asked).toBe(3)
	})

	it('a check that itself wrote a file is still fresh', async () => {
		const { state, config } = workspace('a')
		const ledger = new OutcomeLedger(config)
		await ledger.before([edit('a.ts')])
		state.fingerprint = 'b'
		await ledger.observe(1, [edit('a.ts')])
		await ledger.before([bash('pnpm test')])
		state.fingerprint = 'c'
		await ledger.observe(2, [bash('pnpm test')])
		const outcome = await ledger.finish()
		expect(outcome?.verdict).toBe('checked')
		expect(outcome?.checks[0]?.fresh).toBe(true)
	})

	it('a shell-made change after the check makes it stale', async () => {
		const { state, config } = workspace('a')
		const ledger = new OutcomeLedger(config)
		await ledger.before([edit('a.ts')])
		state.fingerprint = 'b'
		await ledger.observe(1, [edit('a.ts')])
		await ledger.observe(2, [bash('pnpm test')])
		await ledger.before([bash('sed -i s/a/b/ a.ts')])
		state.fingerprint = 'c'
		await ledger.observe(3, [bash('sed -i s/a/b/ a.ts')])
		const outcome = await ledger.finish()
		expect(outcome?.verdict).toBe('stale')
		expect(outcome?.checks[0]?.fresh).toBe(false)
	})

	it('a check followed in the same step by a call that could change things has no fingerprint of its own', async () => {
		const { state, config } = workspace('a')
		const ledger = new OutcomeLedger(config)
		const calls = [bash('pnpm test'), bash('sed -i s/a/b/ a.ts')]
		await ledger.before(calls)
		state.fingerprint = 'b'
		await ledger.observe(1, calls)
		const outcome = await ledger.finish()
		// The state right after the check was never seen, so it cannot be called fresh.
		expect(outcome?.checks[0]).not.toHaveProperty('fresh')
		expect(outcome?.verdict).toBe('inconclusive')
	})

	it('a write after the check in the same step makes it stale without asking the detector', async () => {
		const { state, config } = workspace('a')
		const ledger = new OutcomeLedger(config)
		const calls = [bash('pnpm test'), edit('a.ts')]
		await ledger.before(calls)
		state.fingerprint = 'b'
		const before = state.asked
		await ledger.observe(1, calls)
		expect(state.asked).toBe(before)
		const outcome = await ledger.finish()
		expect(outcome?.verdict).toBe('stale')
	})

	it('a fingerprint that could not be taken after the check is not a match', async () => {
		const { state, config } = workspace('a')
		const ledger = new OutcomeLedger(config)
		await ledger.before([edit('a.ts')])
		state.fingerprint = 'b'
		await ledger.observe(1, [edit('a.ts')])
		state.fingerprint = null
		await ledger.observe(2, [bash('pnpm test')])
		state.fingerprint = 'b'
		const outcome = await ledger.finish()
		expect(outcome?.basis).toBe('workspace')
		expect(outcome?.checks[0]).not.toHaveProperty('fresh')
		expect(outcome?.verdict).toBe('inconclusive')
	})

	it.each([
		['the start', null, 'b'],
		['the end', 'a', null],
	])(
		'a detector with no answer at %s leaves the record on the calls',
		async (_name, start, end) => {
			const { state, config } = workspace(start)
			const ledger = new OutcomeLedger(config)
			await ledger.before([edit('a.ts')])
			state.fingerprint = end
			await ledger.observe(1, [edit('a.ts')])
			await ledger.observe(2, [bash('pnpm test')])
			const outcome = await ledger.finish()
			expect(outcome?.basis).toBe('calls')
			expect(outcome?.verdict).toBe('checked')
			expect(outcome?.changes.total).toBe(1)
		},
	)

	it('a write the detector cannot see still counts as a change', async () => {
		const { config } = workspace('a')
		const outcome = await turn(new OutcomeLedger(config), [[edit('ignored/out.txt')]])
		expect(outcome?.verdict).toBe('unchecked')
		expect(outcome?.changes.outsideKnownTools).toBe(false)
	})

	it('a write after a check that the detector cannot see still makes it stale', async () => {
		const { config } = workspace('a')
		const outcome = await turn(new OutcomeLedger(config), [
			[edit('a.ts')],
			[bash('pnpm test')],
			[edit('ignored/out.txt')],
		])
		expect(outcome?.verdict).toBe('stale')
	})

	it('a detector that throws is a detector with no answer', async () => {
		const ledger = new OutcomeLedger({
			detectChanges: async () => {
				throw new Error('git is gone')
			},
		})
		const outcome = await turn(ledger, [[edit('a.ts')], [bash('pnpm test')]])
		expect(outcome?.basis).toBe('calls')
		expect(outcome?.verdict).toBe('checked')
	})

	it('a detector that is late is a detector with no answer', async () => {
		vi.useFakeTimers()
		const ledger = new OutcomeLedger({ detectChanges: () => new Promise<string | null>(() => {}) })
		const started = ledger.before([edit('a.ts')])
		await vi.advanceTimersByTimeAsync(3000)
		await started
		await ledger.observe(1, [edit('a.ts')])
		const finished = ledger.finish()
		await vi.advanceTimersByTimeAsync(3000)
		const outcome = await finished
		expect(outcome?.basis).toBe('calls')
		expect(outcome?.verdict).toBe('unchecked')
	})

	it('the deadline is the host’s to set', async () => {
		vi.useFakeTimers()
		const ledger = new OutcomeLedger({
			detectChanges: () => new Promise<string | null>(() => {}),
			detectTimeoutMs: 50,
		})
		const started = ledger.before([edit('a.ts')])
		await vi.advanceTimersByTimeAsync(49)
		let settled = false
		void started.then(() => {
			settled = true
		})
		await vi.advanceTimersByTimeAsync(0)
		expect(settled).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		await started
		expect(settled).toBe(true)
	})
})

describe('across a checkpoint', () => {
	it('a resumed turn keeps what happened before the checkpoint', async () => {
		const { state, config } = workspace('a')
		const first = new OutcomeLedger(config)
		await first.before([edit('a.ts')])
		state.fingerprint = 'b'
		await first.observe(1, [edit('a.ts')])
		await first.observe(2, [bash('pnpm test')])

		const kept = JSON.parse(JSON.stringify(first.snapshot()))
		const second = new OutcomeLedger(config)
		second.restore(kept)
		const outcome = await second.finish()
		expect(outcome).toEqual(await first.finish())
		expect(outcome?.verdict).toBe('checked')
		expect(outcome?.changes.paths).toEqual(['a.ts'])
	})

	it('keeps the starting fingerprint, so a change made before the checkpoint is not forgotten', async () => {
		const { state, config } = workspace('a')
		const first = new OutcomeLedger(config)
		await first.before([bash('sed -i s/a/b/ a.ts')])
		state.fingerprint = 'b'
		await first.observe(1, [bash('sed -i s/a/b/ a.ts')])

		const second = new OutcomeLedger(config)
		second.restore(JSON.parse(JSON.stringify(first.snapshot())))
		const outcome = await second.finish()
		expect(outcome?.verdict).toBe('unchecked')
		expect(outcome?.changes.outsideKnownTools).toBe(true)
	})

	it('a turn resumed from a checkpoint with no ledger reports no outcome, not unchanged', async () => {
		const ledger = new OutcomeLedger()
		ledger.markUnrecorded()
		await ledger.observe(1, [read('a.ts')])
		expect(await ledger.finish()).toBeUndefined()
	})

	it.each([
		['not an object', 'nope'],
		['another version', { v: 2 }],
		[
			'a bad check',
			{ v: 1, started: false, startFingerprint: null, paths: [], writes: 0, checks: [{}] },
		],
		[
			'a bad path',
			{ v: 1, started: false, startFingerprint: null, paths: [1], writes: 0, checks: [] },
		],
	])('a snapshot that is %s is not trusted', async (_name, snapshot) => {
		const ledger = new OutcomeLedger()
		ledger.restore(snapshot)
		expect(await ledger.finish()).toBeUndefined()
	})

	it('asks the detector once at the end however often it is finished', async () => {
		const { state, config } = workspace('a')
		const ledger = new OutcomeLedger(config)
		await ledger.before([edit('a.ts')])
		await ledger.observe(1, [edit('a.ts')])
		const first = await ledger.finish()
		const asked = state.asked
		expect(await ledger.finish()).toBe(first)
		expect(state.asked).toBe(asked)
	})
})
