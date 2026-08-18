import { describe, expect, it } from 'vitest'

import { SessionGoalActivation } from '../../../manager/goal/activation.js'
import { InMemorySessionGoalStore } from '../../../store/goal/index.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTaskStore } from '../../../store/task/memory.js'
import type { RunId } from '../../../types/ids/index.js'
import { generateTenantId, generateTopicId } from '../../../utils/id.js'
import { ToolRegistry } from '../../tool/execute.js'
import { HostCommandRegistry } from '../index.js'
import { kernelHostCommands } from '../kernel-commands.js'

/**
 * There was no command seam at all.
 *
 * The whole vocabulary was a literal array in one host's TUI module, over a
 * union shaped by that TUI's concerns — and the coupling had already
 * escaped it: two non-TUI commands import that array from React-adjacent
 * code to build a name list, for facts the kernel owns.
 *
 * The separation from TOOLS is the load-bearing part. A `/tasks` readout is
 * a question the operator asked; making it a tool would let the model call
 * it, spend a turn on it, and put its output in the transcript as if it had
 * discovered something.
 */

const RUN = 'run_cmd' as RunId

async function storeWith(subjects: string[]): Promise<InMemoryTaskStore> {
	const store = new InMemoryTaskStore()
	for (const subject of subjects) {
		await store.create({ runId: RUN, subject } as never)
	}
	return store
}

function registryWith(commands: ReturnType<typeof kernelHostCommands>): HostCommandRegistry {
	const registry = new HostCommandRegistry()
	registry.register(commands)
	return registry
}

async function registryWithGoal() {
	const sessions = new InMemorySessionStore()
	const tenantId = generateTenantId()
	const project = await sessions.createProject({ tenantId, name: 'goal commands' }, tenantId)
	const session = await sessions.createSession(
		{ projectId: project.id, topicId: generateTopicId(), currentActor: null },
		tenantId,
	)
	const store = new InMemorySessionGoalStore({ sessions })
	const activation = new SessionGoalActivation()
	return {
		store,
		activation,
		session,
		tenantId,
		registry: registryWith(
			kernelHostCommands({ goal: { store, sessionId: session.id, tenantId, activation } }),
		),
	}
}

describe('a host command answers from what the kernel owns', () => {
	it('reports the task store contents as rows', async () => {
		const taskStore = await storeWith(['write the thing', 'test the thing'])
		const registry = registryWith(kernelHostCommands({ taskStore }))

		const outcome = await registry.dispatch('/tasks')

		expect(outcome?.kind).toBe('report')
		if (outcome?.kind !== 'report') return
		expect(outcome.rows.map((r) => r.subject)).toEqual(['write the thing', 'test the thing'])
	})

	it('REFUSES rather than reporting zero when there is no store', async () => {
		// The two answers are different and a host cannot tell them apart
		// from an empty array. "There are none" is a measurement; "I have
		// nothing to measure with" is not, and showing the first for the
		// second gives an operator a confident zero nobody computed.
		const registry = registryWith(kernelHostCommands({}))

		const outcome = await registry.dispatch('/tasks')

		expect(outcome?.kind).toBe('refused')
		if (outcome?.kind !== 'refused') return
		expect(outcome.reason).toMatch(/no task store/i)
	})

	it('reports an empty roster as an empty report, not a refusal', async () => {
		// The mirror case, and the reason the distinction is not a blanket
		// rule: "who may I call" with the answer "nobody" is complete and
		// correct for a run with delegation off.
		const outcome = await registryWith(kernelHostCommands({ allowedAgentIds: [] })).dispatch(
			'/agents',
		)

		expect(outcome).toEqual({ kind: 'report', title: 'Agents', rows: [] })
	})
})

describe('/goal is direct host control over durable session state', () => {
	it('refuses without a durable scope instead of inventing an ephemeral goal', async () => {
		const outcome = await registryWith(kernelHostCommands({})).dispatch('/goal ship the release')

		expect(outcome).toMatchObject({ kind: 'refused' })
		if (outcome?.kind === 'refused') expect(outcome.reason).toMatch(/durable session/i)
	})

	it('creates, shows, edits, pauses, resumes and clears one current goal', async () => {
		const { activation, registry, store, session, tenantId } = await registryWithGoal()

		expect(await registry.dispatch('/goal finish the release')).toMatchObject({
			kind: 'ack',
		})
		expect((await store.getGoal(session.id, tenantId))?.objective).toBe('finish the release')
		expect(activation.get(session.id)).toMatchObject({ revision: 1 })
		expect((await registry.dispatch('/goal'))?.kind).toBe('ack')
		expect(await registry.dispatch('/goal edit verify then release')).toMatchObject({
			kind: 'ack',
			message: expect.stringContaining('Goal updated'),
		})
		expect(activation.get(session.id)).toMatchObject({ revision: 2 })
		expect(await registry.dispatch('/goal pause')).toMatchObject({
			kind: 'ack',
			message: expect.stringContaining('Status: paused'),
		})
		expect(activation.get(session.id)).toBeNull()
		expect(await registry.dispatch('/goal resume')).toMatchObject({
			kind: 'ack',
			message: expect.stringContaining('Status: active'),
		})
		expect(activation.get(session.id)).toMatchObject({ revision: 4 })
		const beforeRearm = await store.getGoal(session.id, tenantId)
		activation.disarm(session.id)
		expect(await registry.dispatch('/goal resume')).toMatchObject({
			kind: 'ack',
			message: expect.stringContaining('Goal armed'),
		})
		expect(await store.getGoal(session.id, tenantId)).toEqual(beforeRearm)
		expect(activation.get(session.id)).toMatchObject({ revision: 4 })
		expect(await registry.dispatch('/goal clear')).toEqual({
			kind: 'ack',
			message: 'Goal cleared.',
		})
		expect(await store.getGoal(session.id, tenantId)).toBeNull()
	})

	it('treats a control word as control only when it occupies the whole input', async () => {
		const { registry, store, session, tenantId } = await registryWithGoal()

		await registry.dispatch('/goal pause after verification')

		expect((await store.getGoal(session.id, tenantId))?.objective).toBe('pause after verification')
	})

	it('refuses replacement and missing edit text without changing the current goal', async () => {
		const { registry, store, session, tenantId } = await registryWithGoal()
		await registry.dispatch('/goal original')

		expect(await registry.dispatch('/goal replacement')).toMatchObject({
			kind: 'refused',
		})
		expect(await registry.dispatch('/goal edit')).toMatchObject({
			kind: 'refused',
		})
		expect((await store.getGoal(session.id, tenantId))?.objective).toBe('original')
	})
})

describe('an unknown command is not a refusal', () => {
	it('returns undefined so a host can fall through to its own', async () => {
		// A host layers its own commands under the kernel's — an operator's
		// `.md` files, a TUI's `/clear`. Collapsing "not mine" into "mine,
		// and no" makes every one of those unreachable.
		const registry = registryWith(kernelHostCommands({}))

		expect(await registry.dispatch('/nope')).toBeUndefined()
	})

	it('returns undefined for a line that is not a command at all', async () => {
		const registry = registryWith(kernelHostCommands({}))

		expect(await registry.dispatch('just some prose')).toBeUndefined()
		expect(await registry.dispatch('/')).toBeUndefined()
	})
})

describe('a descriptor survives the wire', () => {
	it('round-trips through JSON with every field intact', async () => {
		// The descriptor is what crosses a process boundary, and a
		// function-valued key survives neither `JSON.stringify` (drops it
		// silently) nor `structuredClone` (throws). Stripping the handler is
		// what makes both paths agree.
		const registry = registryWith(kernelHostCommands({ allowedAgentIds: ['a'] }))
		const described = registry.describe()

		expect(JSON.parse(JSON.stringify(described))).toEqual(described)
		expect(() => structuredClone(described)).not.toThrow()
		for (const command of described) {
			expect(Object.values(command).some((v) => typeof v === 'function')).toBe(false)
		}
	})

	it('lists the commands it holds', async () => {
		// The round-trip above passes trivially against an empty list, and a
		// registry nobody filled is the failure this task exists to avoid.
		const described = registryWith(kernelHostCommands({})).describe()

		expect(described.map((c) => c.name)).toEqual(['agents', 'goal', 'skills', 'tasks'])
	})
})

describe('a host command never becomes a model-visible tool', () => {
	it('does not appear among the callable tools', async () => {
		// The separation is the point. A registered command that leaked into
		// the tool registry would be handed to a provider as a schema, and
		// the model would call the operator's readout and spend a turn on it.
		const tools = new ToolRegistry()
		const commands = registryWith(kernelHostCommands({ allowedAgentIds: ['a'] }))

		const toolNames = tools.listNames()

		for (const command of commands.describe()) {
			expect(toolNames).not.toContain(command.name)
		}
		expect(toolNames).not.toContain('tasks')
		expect(toolNames).not.toContain('agents')
	})
})

describe('two commands cannot share a name', () => {
	it('throws with the name in the message', () => {
		// A silent shadow whose winner depends on registration order —
		// which differs between a host's startup and a test's.
		const registry = new HostCommandRegistry()
		registry.register(kernelHostCommands({}))

		expect(() => registry.register(kernelHostCommands({}))).toThrow(/goal|tasks|agents/)
	})
})
