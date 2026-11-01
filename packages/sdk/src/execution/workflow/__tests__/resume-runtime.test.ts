import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileWorkflowJournal } from '../journal.js'
import { loadWorkflowResume } from '../resume.js'
import type {
	WorkflowAgentEvent,
	WorkflowAgentOutcome,
	WorkflowEvent,
	WorkflowRunOptions,
	WorkflowRunResult,
	WorkflowSpawnAgent,
} from '../types.js'
import { META, makeHost, runScript } from './host.js'

const RUN = 'wresume01'
let dir: string
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'wf-rt-'))
})
afterEach(async () => {
	await rm(dir, { recursive: true, force: true })
})

/** A host that records the prompts it was asked to run. */
function countingHost(answer: (prompt: string) => Partial<WorkflowAgentOutcome> = () => ({})) {
	const prompts: string[] = []
	const spawnAgent: WorkflowSpawnAgent = async (request) => {
		prompts.push(request.prompt)
		return {
			state: 'done',
			text: `ok:${request.prompt}`,
			tokens: 10,
			toolCalls: 1,
			...answer(request.prompt),
		}
	}
	return {
		prompts,
		spawnAgent,
		timeline: [],
		started: [],
		maxRunning: 0,
		reached: async () => {},
	}
}

async function pass(
	script: string,
	host: ReturnType<typeof countingHost>,
	options: Partial<WorkflowRunOptions> = {},
	resumeFrom = false,
): Promise<{ result: WorkflowRunResult; events: WorkflowEvent[] }> {
	const journal = new FileWorkflowJournal(dir, { runId: RUN })
	const resume = resumeFrom ? loadWorkflowResume(await journal.read()) : undefined
	return runScript(script, {
		host,
		runId: RUN,
		journal,
		...(resume ? { resume } : {}),
		...options,
	})
}

const agentEvents = (events: WorkflowEvent[]) =>
	events.filter((e): e is WorkflowAgentEvent => e.type === 'workflow_agent')
const cachedCount = (events: WorkflowEvent[]) =>
	agentEvents(events).filter((e) => e.state === 'done' && e.cached).length

const THREE = `${META}return [await agent('a'), await agent('b'), await agent('c')]`

describe('resuming a run', () => {
	it('returns every saved result of an unchanged script without running an agent', async () => {
		const first = countingHost()
		const r1 = await pass(THREE, first)
		expect(first.prompts).toEqual(['a', 'b', 'c'])
		const second = countingHost()
		const r2 = await pass(THREE, second, {}, true)
		expect(second.prompts).toEqual([])
		expect(r2.result.result).toEqual(r1.result.result)
		expect(r2.result.runId).toBe(RUN)
		expect(r2.result.usage).toMatchObject({
			agents: 3,
			agentsDone: 3,
			tokens: 0,
			cachedAgents: 3,
		})
		expect(cachedCount(r2.events)).toBe(3)
	})

	it('journals a cached hit without a result and keeps compounding passes working', async () => {
		await pass(THREE, countingHost())
		await pass(THREE, countingHost(), {}, true)
		const journal = new FileWorkflowJournal(dir, { runId: RUN })
		const checked = await journal.read()
		const outcomes = checked.records.filter((r) => r.type === 'agent_outcome')
		expect(outcomes.filter((r) => r.cached)).toHaveLength(3)
		expect(outcomes.filter((r) => r.cached).every((r) => !('result' in r))).toBe(true)
		const state = loadWorkflowResume(checked)
		expect(state.pass).toBe(3)
		const third = countingHost()
		const r3 = await pass(THREE, third, {}, true)
		expect(third.prompts).toEqual([])
		expect(r3.result.usage.cachedAgents).toBe(3)
		expect(r3.result.result).toEqual(['ok:a', 'ok:b', 'ok:c'])
	})

	it('runs an edited call and everything after it, and reuses what came before', async () => {
		await pass(THREE, countingHost())
		const edited = `${META}return [await agent('a'), await agent('B!'), await agent('c')]`
		const host = countingHost()
		const { result } = await pass(edited, host, {}, true)
		expect(host.prompts).toEqual(['B!', 'c'])
		expect(result.result).toEqual(['ok:a', 'ok:B!', 'ok:c'])
		expect(result.usage.cachedAgents).toBe(1)
	})

	it('gives identical sequential calls distinct results', async () => {
		let n = 0
		const script = `${META}return [await agent('same'), await agent('same')]`
		await pass(
			script,
			countingHost(() => ({ text: `v${++n}` })),
		)
		const host = countingHost()
		const { result } = await pass(script, host, {}, true)
		expect(host.prompts).toEqual([])
		expect(result.result).toEqual(['v1', 'v2'])
	})

	it('reuses parallel slots ahead of an edit and runs those from the edit on', async () => {
		const script = (second: string) =>
			`${META}return await parallel([() => agent('p1'), () => agent('${second}'), () => agent('p3')])`
		await pass(script('p2'), countingHost())
		const host = countingHost()
		const { result } = await pass(script('p2x'), host, {}, true)
		expect(host.prompts).toEqual(['p2x', 'p3'])
		expect(result.result).toEqual(['ok:p1', 'ok:p2x', 'ok:p3'])
	})

	it('reuses a pipeline whose script did not change', async () => {
		const script = `${META}return await pipeline(['x','y'], (i) => agent('s1:' + i), (v, i) => agent('s2:' + i))`
		const first = await pass(script, countingHost())
		const host = countingHost()
		const second = await pass(script, host, {}, true)
		expect(host.prompts).toEqual([])
		expect(second.result.result).toEqual(first.result.result)
	})

	it('runs a failed agent again and stops reusing results from there on', async () => {
		await pass(
			THREE,
			countingHost((p) => (p === 'b' ? { state: 'error', error: 'boom' } : {})),
		)
		const host = countingHost()
		const { result } = await pass(THREE, host, {}, true)
		expect(host.prompts).toEqual(['b', 'c'])
		expect(result.result).toEqual(['ok:a', 'ok:b', 'ok:c'])
	})

	it('never reuses a skipped agent', async () => {
		await pass(
			THREE,
			countingHost((p) => (p === 'a' ? { state: 'skipped' } : {})),
		)
		const host = countingHost()
		await pass(THREE, host, {}, true)
		expect(host.prompts).toEqual(['a', 'b', 'c'])
	})

	it('saves the value after schema validation', async () => {
		const script = `${META}return await agent('j', { schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } })`
		await pass(
			script,
			countingHost(() => ({ text: '{"n": 7}' })),
		)
		const host = countingHost()
		const { result } = await pass(script, host, {}, true)
		expect(host.prompts).toEqual([])
		expect(result.result).toEqual({ n: 7 })
	})

	it('re-runs the schema call when only the schema changed', async () => {
		const make = (type: string) => `${META}return await agent('j', { schema: { type: '${type}' } })`
		await pass(
			make('object'),
			countingHost(() => ({ text: '{"a":1}' })),
		)
		const host = countingHost(() => ({ text: '"s"' }))
		const { result } = await pass(make('string'), host, {}, true)
		expect(host.prompts).toEqual(['j'])
		expect(result.result).toBe('s')
	})

	it('does not charge the token budget or the saved calls to the new pass, but counts them toward the cap', async () => {
		await pass(THREE, countingHost(), { limits: { tokenBudget: 25 } })
		const { result } = await pass(
			THREE,
			countingHost(),
			{ limits: { tokenBudget: 25, maxAgents: 3 } },
			true,
		)
		expect(result.status).toBe('completed')
		expect(result.usage.tokens).toBe(0)
		const capped = await pass(
			`${THREE.replace('return [', 'return [await agent("d"), ')}`,
			countingHost(),
			{ limits: { maxAgents: 3 } },
			true,
		)
		expect(capped.result.status).toBe('failed')
	})

	it('records the child session id and points a cached hit at the original', async () => {
		await pass(
			THREE,
			countingHost((p) => ({ sessionId: `child-${p}` })),
		)
		const { events } = await pass(THREE, countingHost(), {}, true)
		const checked = await new FileWorkflowJournal(dir, { runId: RUN }).read()
		const cached = checked.records.filter((r) => r.type === 'agent_outcome' && r.cached)
		expect(cached.map((r) => r.type === 'agent_outcome' && r.childSessionId)).toEqual([
			'child-a',
			'child-b',
			'child-c',
		])
		expect(cached.map((r) => r.type === 'agent_outcome' && r.resultFrom)).toEqual([
			{ pass: 1, index: 1 },
			{ pass: 1, index: 2 },
			{ pass: 1, index: 3 },
		])
		expect(cachedCount(events)).toBe(3)
	})

	it('marks the second pass in run_started', async () => {
		await pass(THREE, countingHost())
		await pass(THREE.replace("'c'", "'z'"), countingHost(), { scriptPath: '/x/y.js' }, true)
		const checked = await new FileWorkflowJournal(dir, { runId: RUN }).read()
		const starts = checked.records.filter((r) => r.type === 'run_started')
		expect(starts[0]).not.toHaveProperty('resume')
		expect(starts[1]).toMatchObject({
			resume: {
				pass: 2,
				previousFinish: 'completed',
				scriptSha256Changed: true,
			},
			scriptPath: '/x/y.js',
		})
	})
})

describe('stopped runs', () => {
	it('keeps the cache open for agents the stop cut off', async () => {
		const stop = new AbortController()
		const manual = makeHost({ manual: true })
		const script = `${META}return await parallel([() => agent('a'), () => agent('b'), () => agent('c')])`
		const journal = new FileWorkflowJournal(dir, { runId: RUN })
		const running = runScript(script, {
			host: manual,
			runId: RUN,
			journal,
			signal: stop.signal,
			limits: { maxConcurrency: 2 },
		})
		await manual.reached(2)
		manual.started[0]?.finish({ text: 'A' })
		await manual.reached(3)
		stop.abort(new Error('stop'))
		const stopped = await running
		expect(stopped.result.status).toBe('stopped')
		const state = loadWorkflowResume(await journal.read())
		expect(state.previousFinish).toBe('stopped')
		expect(state.results.size).toBe(1)
		expect(state.failed.size).toBe(0)

		const host = countingHost()
		const { result } = await pass(script, host, {}, true)
		expect(host.prompts).toEqual(['b', 'c'])
		expect(result.result).toEqual(['A', 'ok:b', 'ok:c'])
	})

	it('treats a stopped pipeline the same way', async () => {
		const stop = new AbortController()
		const manual = makeHost({ manual: true })
		const script = `${META}return await pipeline(['x','y'], (i) => agent('s1:' + i), (v, i) => agent('s2:' + i))`
		const journal = new FileWorkflowJournal(dir, { runId: RUN })
		const running = runScript(script, {
			host: manual,
			runId: RUN,
			journal,
			signal: stop.signal,
		})
		await manual.reached(2)
		manual.started[0]?.finish({ text: 'first' })
		await manual.reached(3)
		stop.abort(new Error('stop'))
		await running
		const state = loadWorkflowResume(await journal.read())
		expect(state.failed.size).toBe(0)
		const host = countingHost()
		await pass(script, host, {}, true)
		expect(host.prompts).not.toContain('s1:x')
		expect(host.prompts).toContain('s1:y')
	})

	it('ignores the late result of an earlier pass once a new pass has begun', async () => {
		const manual = makeHost({ manual: true })
		const script = `${META}return await parallel([() => agent('a'), () => agent('b')])`
		const stop = new AbortController()
		const journal = new FileWorkflowJournal(dir, { runId: RUN })
		const running = runScript(script, {
			host: manual,
			runId: RUN,
			journal,
			signal: stop.signal,
		})
		await manual.reached(2)
		stop.abort(new Error('stop'))
		await running
		await journal.append({
			type: 'agent_outcome',
			at: 9,
			index: 1,
			state: 'done',
			tokens: 0,
			toolCalls: 0,
			queuedAt: 1,
			finishedAt: 9,
			key: 'k1:late',
			pass: 1,
			result: 'late',
		})
		// The run is over, so a straggler is not written at all.
		const state = loadWorkflowResume(await journal.read())
		expect(state.results.has('k1:late')).toBe(false)
	})
})

describe('deterministic scripts', () => {
	const run = (body: string) =>
		runScript(`${META}${body}`, { deterministic: true, host: countingHost() })

	it('rejects the clock and Math.random with a message that names the fix', async () => {
		for (const body of [
			'return Date.now()',
			'return new Date().getTime()',
			'return Date()',
			'return Math.random()',
		]) {
			const { result } = await run(body)
			expect(result.status, body).toBe('failed')
			expect(result.error, body).toMatch(/breaks resume/)
		}
	})

	it('keeps dates that do not read the clock', async () => {
		const { result } = await run(
			'return [new Date(0).toISOString(), Date.UTC(2020, 0, 1), Date.parse("2020-01-01T00:00:00Z"), new Date(2020, 0, 2) instanceof Date]',
		)
		expect(result.result).toEqual(['1970-01-01T00:00:00.000Z', 1577836800000, 1577836800000, true])
	})

	it('cannot reach the real clock through the prototype, and has no eval', async () => {
		const { result } = await run('return Object.getPrototypeOf(new Date(0)).constructor.now()')
		expect(result.status).toBe('failed')
		const none = await run('return typeof eval')
		expect(none.result.result).toBe('undefined')
	})

	it('leaves the clock alone unless asked', async () => {
		const { result } = await runScript(`${META}return [typeof Date.now(), typeof Math.random()]`)
		expect(result.result).toEqual(['number', 'number'])
	})

	it('says a failed run can be resumed only when the host can', async () => {
		const body = `${META}await agent('a'); throw new Error('later')`
		const plain = await runScript(body)
		expect(plain.result.error).toContain('A rerun starts the whole script again')
		const resumable = await runScript(body, { canResume: true })
		expect(resumable.result.error).toContain('Resume the run to continue')
	})
})
