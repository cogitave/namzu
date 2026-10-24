import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FileWorkflowJournal } from '../journal.js'
import { summarizeWorkflowPhases } from '../phases.js'
import type {
	WorkflowAgentEvent,
	WorkflowEvent,
	WorkflowJournalRecord,
	WorkflowPhaseEvent,
} from '../types.js'
import { META, makeHost, runScript } from './host.js'

const agentEvents = (events: WorkflowEvent[]) =>
	events.filter((e): e is WorkflowAgentEvent => e.type === 'workflow_agent')
const phaseEvents = (events: WorkflowEvent[]) =>
	events.filter((e): e is WorkflowPhaseEvent => e.type === 'workflow_phase')

/** Resolves once `count` agents have been queued (their first event), without any timer. */
function queuedAgents(count: number) {
	const seen = new Set<number>()
	let resolve: () => void = () => {}
	const all = new Promise<void>((r) => {
		resolve = r
	})
	return {
		all,
		onEvent: (event: WorkflowEvent) => {
			if (event.type === 'workflow_agent') seen.add(event.index)
			if (seen.size >= count) resolve()
		},
	}
}

describe('agent()', () => {
	it('resolves to the agent text and returns the script value', async () => {
		const { result } = await runScript(`${META}const a = await agent('one'); return { a, args }`, {
			args: { n: 3 },
		})
		expect(result.status).toBe('completed')
		expect(result.result).toEqual({ a: 'ok:one', args: { n: 3 } })
		expect(result.usage).toMatchObject({ agents: 1, agentsDone: 1, tokens: 10, toolCalls: 1 })
		expect(result.runId).toMatch(/^w[0-9a-z]{8}$/)
	})

	it('resolves null when the agent failed or was skipped', async () => {
		let n = 0
		const host = makeHost()
		const { result, events } = await runScript(
			`${META}return [await agent('a'), await agent('b'), await agent('c')]`,
			{
				host: {
					...host,
					spawnAgent: async () => {
						n++
						if (n === 1) return { state: 'error', tokens: 3, toolCalls: 0, error: 'boom' }
						if (n === 2) return { state: 'skipped', tokens: 0, toolCalls: 0 }
						return { state: 'done', text: 'fine', tokens: 1, toolCalls: 0 }
					},
				},
			},
		)
		expect(result.result).toEqual([null, null, 'fine'])
		const done = agentEvents(events).filter((e) => e.state === 'done' || e.state === 'error')
		expect(done.map((e) => [e.state, e.skipped ?? false, e.error])).toEqual([
			['error', false, 'boom'],
			['done', true, undefined],
			['done', false, undefined],
		])
		expect(result.usage).toMatchObject({ agentsDone: 1, agentsFailed: 1, agentsSkipped: 1 })
	})

	it('treats a throwing spawnAgent as a failed agent', async () => {
		const { result } = await runScript(`${META}return await agent('x')`, {
			host: {
				...makeHost(),
				spawnAgent: async () => {
					throw new Error('spawn broke')
				},
			},
		})
		expect(result.result).toBeNull()
		expect(result.status).toBe('completed')
		expect(result.usage.agentsFailed).toBe(1)
	})

	it('passes label, agentType, model and effort to the host', async () => {
		const host = makeHost()
		await runScript(
			`${META}await agent('p', { label: ' my   label ', agentType: 'explorer', model: 'm', effort: 'high' })`,
			{ host },
		)
		expect(host.started[0]?.request).toMatchObject({
			index: 1,
			label: 'my label',
			prompt: 'p',
			agentType: 'explorer',
			model: 'm',
			effort: 'high',
		})
	})

	it('rejects a call without a prompt inside the script', async () => {
		const { result } = await runScript(
			`${META}try { await agent(''); return 'no' } catch (e) { return e.message }`,
		)
		expect(result.result).toBe(
			'agent(prompt, options?): the prompt must be a non-empty string, got an empty string',
		)
	})
})

describe('schema', () => {
	const schema = {
		type: 'object',
		required: ['n'],
		properties: { n: { type: 'integer' } },
		additionalProperties: false,
	}
	const run = (outcome: object) =>
		runScript(`${META}return await agent('q', { schema: args.schema })`, {
			args: { schema },
			host: {
				...makeHost(),
				spawnAgent: async () => ({ state: 'done', tokens: 1, toolCalls: 0, ...outcome }) as never,
			},
		})

	it('returns the validated object from data', async () => {
		expect((await run({ data: { n: 2 } })).result.result).toEqual({ n: 2 })
	})

	it('parses JSON text, tolerating a code fence', async () => {
		expect((await run({ text: '```json\n{"n": 5}\n```' })).result.result).toEqual({ n: 5 })
	})

	it('resolves null and records why when the answer does not match', async () => {
		const { result, events } = await run({ data: { n: 'x' } })
		expect(result.result).toBeNull()
		const last = agentEvents(events).at(-1)
		expect(last?.state).toBe('error')
		expect(last?.error).toMatch(/did not match the schema: n must be integer/)
	})

	it('resolves null for text that is not JSON', async () => {
		const { events } = await run({ text: 'not json' })
		expect(agentEvents(events).at(-1)?.error).toMatch(/not valid JSON/)
	})

	it('hands the schema to the host', async () => {
		const host = makeHost()
		await runScript(`${META}await agent('q', { schema: args.schema })`, { host, args: { schema } })
		expect(host.started[0]?.request.schema).toEqual(schema)
	})
})

describe('parallel and pipeline', () => {
	it('parallel is a barrier: the next agent starts after every thunk finished', async () => {
		const host = makeHost({ manual: true })
		const run = runScript(
			`${META}
			const rs = await parallel([1, 2, 3].map((i) => () => agent('p' + i)))
			const after = await agent('after')
			return { rs, after }`,
			{ host },
		)
		await host.reached(3)
		host.started[2]?.finish()
		host.started[0]?.finish()
		host.started[1]?.finish()
		await host.reached(4)
		host.started[3]?.finish()
		const { result } = await run
		expect(result.result).toEqual({ rs: ['ok:p1', 'ok:p2', 'ok:p3'], after: 'ok:after' })
		expect(host.timeline.indexOf('start:4')).toBeGreaterThan(host.timeline.lastIndexOf('end:3'))
		expect(host.timeline.indexOf('start:4')).toBeGreaterThan(host.timeline.indexOf('end:1'))
		expect(host.timeline.indexOf('start:4')).toBeGreaterThan(host.timeline.indexOf('end:2'))
	})

	it('pipeline runs per-item chains with no barrier between stages', async () => {
		const host = makeHost({ manual: true })
		const run = runScript(
			`${META}return await pipeline(['a', 'b'], (x) => agent('s1-' + x), (t) => agent('s2-' + t))`,
			{ host },
		)
		await host.reached(2)
		// Item "a" finishes stage 1 while "b" is still in stage 1.
		host.started[0]?.finish()
		await host.reached(3)
		expect(host.started[2]?.request.prompt).toBe('s2-ok:s1-a')
		expect(host.timeline).not.toContain('end:2')
		host.started[1]?.finish()
		await host.reached(4)
		host.started[2]?.finish()
		host.started[3]?.finish()
		expect((await run).result.result).toEqual(['ok:s2-ok:s1-a', 'ok:s2-ok:s1-b'])
	})

	it('pipeline stops an item at the first stage that resolves null', async () => {
		const host = makeHost()
		const { result } = await runScript(
			`${META}return await pipeline([1, 2], (x) => (x === 1 ? null : agent('keep')), (t, i, item) => agent('next-' + i + '-' + item))`,
			{ host },
		)
		expect(result.result).toEqual([null, 'ok:next-1-2'])
		expect(host.started.map((s) => s.request.prompt)).toEqual(['keep', 'next-1-2'])
	})

	it('parallel never rejects: a throwing thunk resolves to null and says why through log()', async () => {
		const host = makeHost()
		const { result, events } = await runScript(
			`${META}return await parallel([() => agent('a'), () => { throw new Error('boom') }, async () => { throw new TypeError('late') }, () => agent('b')])`,
			{ host },
		)
		expect(result.status).toBe('completed')
		expect(result.result).toEqual(['ok:a', null, null, 'ok:b'])
		const logs = events
			.filter((e) => e.type === 'workflow_log')
			.map((e) => (e as { message: string }).message)
		expect(logs).toEqual(['Step 2 stopped: boom', 'Step 3 stopped: late'])
	})

	it('pipeline drops an item whose stage throws to null and keeps the others', async () => {
		const host = makeHost()
		const { result, events } = await runScript(
			`${META}return await pipeline([1, 2], (x) => { if (x === 1) throw new Error('nope'); return agent('keep') }, (t) => agent('next-' + t))`,
			{ host },
		)
		expect(result.status).toBe('completed')
		expect(result.result).toEqual([null, 'ok:next-ok:keep'])
		const logs = events
			.filter((e) => e.type === 'workflow_log')
			.map((e) => (e as { message: string }).message)
		expect(logs).toEqual(['Item 1 stopped at step 1: nope'])
	})

	it('refuses non-array input and non-function stages', async () => {
		const { result } = await runScript(
			`${META}const out = []
			for (const f of [() => parallel(1), () => pipeline(1), () => pipeline([1], 2)]) {
				try { await f() } catch (e) { out.push(e.message) }
			}
			return out`,
		)
		expect(result.result).toEqual([
			'parallel(thunks): the argument must be an array of functions, got a number',
			'pipeline(items, ...stages): the first argument must be an array, got a number',
			'pipeline(items, ...stages): stage 1 must be a function, got a number',
		])
	})
})

describe('phases', () => {
	const declared =
		"export const meta = { name: 'p', description: 'd', phases: [{ title: 'Scan' }, { title: 'Fix', detail: 'safe only' }] }\n"

	it('pre-announces declared titles in order, before any agent', async () => {
		const { events } = await runScript(`${declared}await agent('x')`)
		const kinds = events.map((e) => e.type)
		expect(kinds.slice(0, 3)).toEqual(['workflow_started', 'workflow_phase', 'workflow_phase'])
		expect(phaseEvents(events).map((p) => [p.index, p.title, p.declared])).toEqual([
			[1, 'Scan', true],
			[2, 'Fix', true],
		])
		expect(kinds.at(-1)).toBe('workflow_finished')
	})

	it('groups by the global cursor, an explicit phase wins, and one title is one group', async () => {
		const host = makeHost()
		const { result, events } = await runScript(
			`${declared}
			phase('Scan')
			await parallel([1, 2].map((i) => () => agent('s' + i)))
			phase('Fix')
			await agent('f1')
			await agent('late', { phase: 'Scan' })
			await agent('extra', { phase: 'Brand new' })
			phase('Brand new')
			await agent('again')
			phase('  Scan ')
			await agent('scan again')`,
			{ host },
		)
		const byPrompt = new Map(
			agentEvents(events)
				.filter((e) => e.state === 'start' && e.startedAt === undefined)
				.map((e) => [host.started[e.index - 1]?.request.prompt, [e.phaseIndex, e.phaseTitle]]),
		)
		expect(byPrompt.get('s1')).toEqual([1, 'Scan'])
		expect(byPrompt.get('s2')).toEqual([1, 'Scan'])
		expect(byPrompt.get('f1')).toEqual([2, 'Fix'])
		expect(byPrompt.get('late')).toEqual([1, 'Scan'])
		expect(byPrompt.get('extra')).toEqual([3, 'Brand new'])
		expect(byPrompt.get('again')).toEqual([3, 'Brand new'])
		expect(byPrompt.get('scan again')).toEqual([1, 'Scan'])
		expect(phaseEvents(events).map((p) => [p.index, p.title, p.declared])).toEqual([
			[1, 'Scan', true],
			[2, 'Fix', true],
			[3, 'Brand new', false],
		])
		expect(result.phases.map((p) => [p.index, p.title, p.status, p.agents])).toEqual([
			[1, 'Scan', 'done', 4],
			[2, 'Fix', 'done', 1],
			[3, 'Brand new', 'done', 2],
		])
		expect(result.phases[1]?.detail).toBe('safe only')
	})

	it('shows a declared phase with no agents as not started', async () => {
		const { result } = await runScript(`${declared}phase('Scan'); await agent('x')`)
		expect(result.phases.map((p) => [p.title, p.status])).toEqual([
			['Scan', 'done'],
			['Fix', 'not-started'],
		])
	})

	it('reports a run with no phases as one "Agents" group', async () => {
		const { result, events } = await runScript(`${META}await agent('x'); await agent('y')`)
		expect(phaseEvents(events)).toEqual([])
		expect(agentEvents(events).every((e) => e.phaseIndex === undefined)).toBe(true)
		expect(result.phases).toEqual([
			{ index: 0, title: 'Agents', status: 'done', agents: 2, done: 2, failed: 0, tokens: 20 },
		])
	})

	it('derives failed and running statuses from the agents', () => {
		const phases = [
			{ index: 1, title: 'A', declared: true },
			{ index: 2, title: 'B', declared: false },
		]
		const out = summarizeWorkflowPhases([], phases, [
			{ phaseIndex: 1, state: 'done', tokens: 1 },
			{ phaseIndex: 1, state: 'error', tokens: 2 },
			{ phaseIndex: 2, state: 'progress', tokens: 4 },
			{ state: 'done', tokens: 8 },
		])
		expect(out.map((p) => [p.title, p.status, p.tokens])).toEqual([
			['A', 'failed', 3],
			['B', 'running', 4],
			['Agents', 'done', 8],
		])
	})

	it('ignores an empty phase title with a plain error', async () => {
		const { result } = await runScript(`${META}try { phase('   ') } catch (e) { return e.message }`)
		expect(result.result).toBe('phase() needs a non-empty title.')
	})
})

describe('scheduling', () => {
	it('never runs more agents than the cap, and starts them in FIFO order', async () => {
		const host = makeHost({ manual: true })
		const run = runScript(
			`${META}return await parallel([1, 2, 3, 4, 5].map((i) => () => agent('a' + i)))`,
			{ host, limits: { maxConcurrency: 2 } },
		)
		await host.reached(2)
		for (let n = 0; n < 5; n++) {
			await host.reached(Math.min(n + 2, 5))
			host.started[n]?.finish()
		}
		const { result, events } = await run
		expect(host.maxRunning).toBe(2)
		expect(host.started.map((s) => s.request.index)).toEqual([1, 2, 3, 4, 5])
		expect(result.result).toEqual(['ok:a1', 'ok:a2', 'ok:a3', 'ok:a4', 'ok:a5'])
		// Queued ("start" without startedAt) comes before running ("start" with startedAt).
		const third = agentEvents(events).filter((e) => e.index === 3 && e.state === 'start')
		expect(third.map((e) => e.startedAt !== undefined)).toEqual([false, true])
	})

	it('fails the run when the script asks for more agents than the cap', async () => {
		const host = makeHost({ manual: true })
		const run = runScript(
			`${META}return await parallel([1, 2, 3, 4, 5].map((i) => () => agent('a' + i)))`,
			{ host, limits: { maxAgents: 3, maxConcurrency: 4 } },
		)
		const { result } = await run
		expect(result.status).toBe('failed')
		expect(result.error).toMatch(/more than 3 agents/)
		expect(host.started).toHaveLength(3)
		expect(host.started.every((s) => s.signal.aborted)).toBe(true)
	})

	it('stops admitting agents once the token budget is spent', async () => {
		const host = makeHost()
		const { result, events } = await runScript(
			`${META}const out = []
			for (let i = 0; i < 4; i++) out.push(await agent('a' + i))
			return { out, budget: { used: budget.tokensUsed, limit: budget.tokenLimit } }`,
			{ host, limits: { tokenBudget: 15 } },
		)
		expect(result.result).toEqual({
			out: ['ok:a0', 'ok:a1', null, null],
			budget: { used: 20, limit: 15 },
		})
		expect(host.started).toHaveLength(2)
		const refused = agentEvents(events).filter((e) => e.state === 'error')
		expect(refused).toHaveLength(2)
		expect(refused[0]?.error).toMatch(/token budget/)
		expect(result.usage.tokens).toBe(20)
	})

	it('exposes an unlimited budget as undefined', async () => {
		const { result } = await runScript(
			`${META}return typeof budget.tokenLimit + ':' + budget.tokensUsed`,
		)
		expect(result.result).toBe('undefined:0')
	})

	it('validates limits with a plain RangeError', async () => {
		await expect(runScript(`${META}return 1`, { limits: { maxConcurrency: 99 } })).rejects.toThrow(
			'maxConcurrency must be an integer between 1 and 16',
		)
	})
})

describe('cancellation and skipping', () => {
	it('stops queued agents, aborts running ones and reports stopped', async () => {
		const host = makeHost({ manual: true })
		const controller = new AbortController()
		const queued = queuedAgents(3)
		const run = runScript(
			`${META}return await parallel([1, 2, 3].map((i) => () => agent('a' + i)))`,
			{ host, signal: controller.signal, limits: { maxConcurrency: 1 }, onEvent: queued.onEvent },
		)
		await host.reached(1)
		await queued.all
		controller.abort()
		const { result, events } = await run
		expect(result.status).toBe('stopped')
		expect(host.started).toHaveLength(1)
		expect(host.started[0]?.signal.aborted).toBe(true)
		const final = agentEvents(events).filter((e) => e.state === 'error')
		expect(final.map((e) => e.index).sort()).toEqual([1, 2, 3])
		expect(events.at(-1)).toMatchObject({ type: 'workflow_finished', status: 'stopped' })
	})

	it('reports stopped without starting anything when already aborted', async () => {
		const host = makeHost()
		const { result } = await runScript(`${META}return await agent('x')`, {
			host,
			signal: AbortSignal.abort(),
		})
		expect(result.status).toBe('stopped')
		expect(host.started).toHaveLength(0)
	})

	it('skips a queued agent and aborts a running one on request', async () => {
		const host = makeHost({ manual: true })
		let control: { skipAgent(i: number): boolean } | undefined
		const queued = queuedAgents(2)
		const run = runScript(`${META}return await parallel([1, 2].map((i) => () => agent('a' + i)))`, {
			host,
			limits: { maxConcurrency: 1 },
			onControl: (c) => {
				control = c
			},
			onEvent: queued.onEvent,
		})
		await host.reached(1)
		await queued.all
		expect(control?.skipAgent(2)).toBe(true) // queued: never starts
		expect(control?.skipAgent(1)).toBe(true) // running: aborted
		expect(control?.skipAgent(99)).toBe(false)
		const { result, events } = await run
		expect(result.result).toEqual([null, null])
		expect(host.started).toHaveLength(1)
		expect(result.usage).toMatchObject({ agentsSkipped: 2, agentsFailed: 0 })
		expect(control?.skipAgent(1)).toBe(false)
		expect(agentEvents(events).filter((e) => e.skipped)).toHaveLength(2)
	})
})

describe('events', () => {
	it('emits start (queued), start (running), progress, done in order, then finished', async () => {
		const clock = { t: 1000 }
		const events: WorkflowEvent[] = []
		const { WorkflowRuntime } = await import('../runtime.js')
		const result = await new WorkflowRuntime({
			now: () => {
				clock.t += 5
				return clock.t
			},
		}).run({
			script: `${META}log('hello'); return await agent('go', { label: 'L' })`,
			spawnAgent: async (request) => {
				request.onProgress({
					tokens: 4,
					toolCalls: 1,
					lastToolName: 'grep',
					lastToolSummary: 'src',
				})
				return { state: 'done', text: 'fin', tokens: 9, toolCalls: 2 }
			},
			onEvent: (e) => events.push(e),
		})
		expect(events.map((e) => (e.type === 'workflow_agent' ? `agent:${e.state}` : e.type))).toEqual([
			'workflow_started',
			'workflow_log',
			'agent:start',
			'agent:start',
			'agent:progress',
			'agent:done',
			'workflow_finished',
		])
		const [queued, running, progress, done] = agentEvents(events)
		expect(queued).toMatchObject({ index: 1, label: 'L', promptPreview: 'go' })
		expect(queued?.startedAt).toBeUndefined()
		expect(running?.startedAt).toBeGreaterThan(queued?.queuedAt ?? 0)
		expect(progress).toMatchObject({
			tokens: 4,
			toolCalls: 1,
			lastToolName: 'grep',
			lastToolSummary: 'src',
		})
		expect(done).toMatchObject({ tokens: 9, toolCalls: 2, resultPreview: 'fin' })
		expect(done?.finishedAt).toBeGreaterThan(done?.startedAt ?? 0)
		expect(events.at(-1)).toMatchObject({
			type: 'workflow_finished',
			status: 'completed',
			result: 'fin',
			usage: { agents: 1, tokens: 9, toolCalls: 2 },
		})
		expect(events[1]).toMatchObject({ type: 'workflow_log', message: 'hello' })
		expect(result.usage.elapsedMs).toBeGreaterThan(0)
	})

	it('survives a throwing listener and ignores late progress', async () => {
		let late: (() => void) | undefined
		const { WorkflowRuntime } = await import('../runtime.js')
		const result = await new WorkflowRuntime().run({
			script: `${META}return await agent('x')`,
			spawnAgent: async (request) => {
				late = () => request.onProgress({ tokens: 99 })
				return { state: 'done', text: 'ok', tokens: 1, toolCalls: 0 }
			},
			onEvent: () => {
				throw new Error('listener bug')
			},
		})
		late?.()
		expect(result.status).toBe('completed')
		expect(result.usage.tokens).toBe(1)
	})

	it('reports a script that throws as failed with its message', async () => {
		const { result, events } = await runScript(`${META}throw new Error('script broke')`)
		expect(result.status).toBe('failed')
		expect(result.error).toMatch(
			/^Error: script broke — line 2, column \d+: throw new Error\('script broke'\)/,
		)
		expect(events.at(-1)).toMatchObject({ type: 'workflow_finished', status: 'failed' })
	})

	it('truncates very long log output and says so', async () => {
		const { result } = await runScript(
			`${META}for (let i = 0; i < 400; i++) log('x'.repeat(1900)); return 1`,
		)
		expect(result.logsTruncated).toBe(true)
		expect(result.status).toBe('completed')
	})
})

describe('journal', () => {
	it('records every step through an injected store', async () => {
		const records: WorkflowJournalRecord[] = []
		let script = ''
		const { result } = await runScript(
			`export const meta = { name: 'j', description: 'd', phases: [{ title: 'One' }] }
			phase('One'); log('note')
			return await agent('secret prompt body', { label: 'A', schema: { type: 'string' } })`,
			{
				args: { k: 1 },
				host: {
					...makeHost(),
					spawnAgent: async () => ({ state: 'done', text: '"v"', tokens: 2, toolCalls: 1 }),
				},
				journal: {
					writeScript: (source) => {
						script = source
					},
					append: (record) => {
						records.push(record)
					},
				},
			},
		)
		expect(result.status).toBe('completed')
		expect(script).toContain('secret prompt body')
		expect(records.map((r) => r.type)).toEqual([
			'run_started',
			'phase',
			'log',
			'agent_request',
			'agent_outcome',
			'run_finished',
		])
		expect(records[0]).toMatchObject({
			type: 'run_started',
			args: { k: 1 },
			meta: { name: 'j' },
			scriptBytes: Buffer.byteLength(script),
			limits: { maxAgents: 200 },
		})
		expect(records[3]).toMatchObject({
			type: 'agent_request',
			index: 1,
			label: 'A',
			phaseIndex: 1,
			phaseTitle: 'One',
			promptSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			options: { schema: true },
		})
		expect(records[4]).toMatchObject({
			type: 'agent_outcome',
			state: 'done',
			tokens: 2,
			resultPreview: 'v',
		})
		expect(records[5]).toMatchObject({ type: 'run_finished', status: 'completed', result: 'v' })
	})

	it('keeps running and reports it when the journal cannot be written', async () => {
		const { result } = await runScript(`${META}return await agent('x')`, {
			journal: {
				writeScript: () => {
					throw new Error('disk full')
				},
				append: () => {
					throw new Error('disk full')
				},
			},
		})
		expect(result.status).toBe('completed')
		expect(result.journalError).toBe('disk full')
	})

	it('writes script.js and journal.jsonl on disk', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'wf-journal-'))
		try {
			const script = `${META}return await agent('hello')`
			const { result } = await runScript(script, {
				journal: new FileWorkflowJournal(join(dir, 'a', 'workflow')),
			})
			expect(await readFile(join(dir, 'a', 'workflow', 'script.js'), 'utf8')).toBe(script)
			const lines = (await readFile(join(dir, 'a', 'workflow', 'journal.jsonl'), 'utf8'))
				.trim()
				.split('\n')
			const types = lines.map((l) => (JSON.parse(l) as { type: string }).type)
			expect(types).toEqual(['run_started', 'agent_request', 'agent_outcome', 'run_finished'])
			expect(result.journalError).toBeUndefined()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe('refusals before anything starts', () => {
	it('refuses an oversized script, bad meta and unusable args without events', async () => {
		const events: WorkflowEvent[] = []
		const base = { onEvent: (e: WorkflowEvent) => events.push(e) }
		await expect(
			runScript(`${META}// ${'x'.repeat(2000)}`, { ...base, limits: { maxSourceBytes: 1000 } }),
		).rejects.toThrow('larger than 1000 bytes')
		await expect(runScript('return 1', base)).rejects.toThrow('must start with')
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		await expect(runScript(`${META}return 1`, { ...base, args: cyclic })).rejects.toThrow(
			'arguments cannot be used',
		)
		await expect(
			runScript(`${META}return 1`, { ...base, args: 'x'.repeat(70_000) }),
		).rejects.toThrow('arguments cannot be used')
		expect(events).toEqual([])
	})

	it('fails the run when the script returns more than one value limit', async () => {
		const { result } = await runScript(`${META}return 'x'.repeat(5000)`, {
			limits: { maxValueBytes: 1000 },
		})
		expect(result.status).toBe('failed')
		expect(result.error).toMatch(/exceeds 1000 bytes/)
	})

	it('does not hand the script a result bigger than the value limit', async () => {
		const { result, events } = await runScript(`${META}return await agent('x')`, {
			limits: { maxValueBytes: 1000 },
			host: {
				...makeHost(),
				spawnAgent: async () => ({
					state: 'done',
					text: 'y'.repeat(5000),
					tokens: 1,
					toolCalls: 0,
				}),
			},
		})
		expect(result.status).toBe('completed')
		expect(result.result).toBeNull()
		expect(agentEvents(events).at(-1)?.error).toMatch(/larger than 1000 bytes/)
	})
})
