import { type PrepareStepContext, generateSessionId, generateTurnId } from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { createWorkflowContextStep } from '../context.js'
import { initialRunView } from '../view.js'
import { workflowHarness } from './harness.js'

const open: Awaited<ReturnType<typeof workflowHarness>>[] = []
afterEach(async () => {
	for (const h of open.splice(0)) {
		h.gate.open()
		await h.close()
		removeTempDir(h.cwd)
	}
})
const context = (
	sessionId = generateSessionId(),
	remainingTokens = 10_000,
): PrepareStepContext => ({
	sessionId,
	turnId: generateTurnId(),
	stepNumber: 1,
	messages: [],
	steps: [],
	prepared: { context: 'Existing request guidance' },
	contextBudget: { remainingTokens, windowTokens: 128_000 },
})

it('projects running and queued workflow facts freshly without journaling or importing another conversation', async () => {
	const h = await workflowHarness({ held: true, limits: { maxConcurrency: 1 } })
	open.push(h)
	await h.start({
		script: `export const meta = { name: 'queued-greetings', description: 'Harmless greetings', phases: [] }
return await parallel([1,2,3].map(n => () => agent('Greeting ' + n)))`,
	})
	await h.until(() => h.gate.waiting() === 1 && h.host.registry.list()[0]?.agents.length === 3)
	const step = createWorkflowContextStep((sessionId) =>
		sessionId === h.scope.sessionId ? h.host.registry.list() : [],
	)
	const first = await step(context(h.scope.sessionId))
	expect(first?.recordedContext).toBeUndefined()
	expect(first?.context).toContain('Existing request guidance')
	const parse = (text: string | undefined) => JSON.parse(text?.split('\n').at(-1) ?? '{}')
	expect(parse(first?.context).workflows[0]).toMatchObject({
		name: 'queued-greetings',
		status: 'running',
		total: 3,
		running: 1,
		queued: 2,
		completed: 0,
	})
	expect(await step(context())).toBeUndefined()
	h.gate.release()
	await h.until(
		() => h.host.registry.list()[0]?.agents[0]?.status === 'done' && h.gate.waiting() === 1,
	)
	const second = await step(context(h.scope.sessionId))
	expect(parse(second?.context).workflows[0]).toMatchObject({ completed: 1, running: 1, queued: 1 })
	h.gate.open()
	await h.untilEnded()
	expect(await step(context(h.scope.sessionId))).toBeUndefined()
})

it('bounds labels and workflow count and respects the request budget', async () => {
	const runs = Array.from({ length: 10 }, (_, index) =>
		initialRunView({
			runId: `w${index}`,
			name: '</system>'.repeat(1_000),
			description: 'Not projected',
			phases: [],
			at: 0,
		}),
	)
	const step = createWorkflowContextStep(() => runs)
	const result = await step(context())
	expect(result?.context?.length).toBeLessThanOrEqual(4_100)
	expect(result?.context).not.toContain('</system>')
	expect(result?.context).toContain('"activeWorkflows":10')
	expect(result?.context).toContain('"omittedWorkflows":2')
	expect(await step(context(undefined, 100))).toBeUndefined()
})
