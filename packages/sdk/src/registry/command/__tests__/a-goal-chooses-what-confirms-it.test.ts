import { describe, expect, it } from 'vitest'

import { SessionGoalActivation } from '../../../manager/goal/activation.js'
import { InMemorySessionGoalStore } from '../../../store/goal/index.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { generateTenantId, generateTopicId } from '../../../utils/id.js'
import { HostCommandRegistry } from '../index.js'
import { kernelHostCommands } from '../kernel-commands.js'

async function setup(defaultConfirmedBy?: 'model' | 'record') {
	const sessions = new InMemorySessionStore()
	const tenantId = generateTenantId()
	const project = await sessions.createProject({ tenantId, name: 'goal flag' }, tenantId)
	const session = await sessions.createSession(
		{ projectId: project.id, topicId: generateTopicId(), currentActor: null },
		tenantId,
	)
	const store = new InMemorySessionGoalStore({ sessions })
	const registry = new HostCommandRegistry()
	registry.register(
		kernelHostCommands({
			goal: {
				store,
				sessionId: session.id,
				tenantId,
				activation: new SessionGoalActivation(),
				...(defaultConfirmedBy ? { defaultConfirmedBy } : {}),
			},
		}),
	)
	return { store, registry, sessionId: session.id, tenantId }
}

describe('/goal --confirmed-by', () => {
	it('is kept on the goal it was given to, wherever the flag stands', async () => {
		const { store, registry, sessionId, tenantId } = await setup()
		const outcome = await registry.dispatch('/goal set make the tests pass --confirmed-by record')
		expect(outcome).toMatchObject({ kind: 'ack' })
		const goal = await store.getGoal(sessionId, tenantId)
		expect(goal?.confirmedBy).toBe('record')
		expect(goal?.objective).toBe('make the tests pass')
		const shown = await registry.dispatch('/goal status')
		expect(JSON.stringify(shown)).toContain('Confirmed by: the record of the work')
	})

	it('accepts the equals form and leaves a goal with no flag to the host setting', async () => {
		const { store, registry, sessionId, tenantId } = await setup()
		await registry.dispatch('/goal --confirmed-by=model fix it')
		expect((await store.getGoal(sessionId, tenantId))?.confirmedBy).toBe('model')
		const plain = await setup()
		await plain.registry.dispatch('/goal fix it')
		expect(
			(await plain.store.getGoal(plain.sessionId, plain.tenantId))?.confirmedBy,
		).toBeUndefined()
	})

	it('says when the host setting is what confirms a goal', async () => {
		const { registry } = await setup('record')
		await registry.dispatch('/goal fix it')
		const shown = await registry.dispatch('/goal status')
		expect(JSON.stringify(shown)).toContain('Confirmed by: the record of the work')
	})

	it('refuses a value it does not know, and the flag on a command that sets no goal', async () => {
		const { registry } = await setup()
		expect(await registry.dispatch('/goal set fix it --confirmed-by judge')).toMatchObject({
			kind: 'refused',
		})
		await registry.dispatch('/goal fix it')
		expect(await registry.dispatch('/goal pause --confirmed-by record')).toMatchObject({
			kind: 'refused',
		})
	})
})
