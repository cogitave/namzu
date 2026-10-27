import {
	type ChildSessionSummary,
	type PrepareStepContext,
	createTurnContextEntry,
	generateSessionId,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import {
	type LogHome,
	endChild,
	logHome,
	parentSession,
	spawnChild,
} from '../__fixtures__/session-logs.js'
import type { SavedChildIndex } from '../replay.js'
import {
	MAX_LISTED_SAVED_AGENTS,
	MAX_SAVED_OUTPUT_CODE_UNITS,
	SAVED_AGENTS_KEY,
	createSavedAgentHistory,
	createSavedAgentsStep,
} from '../saved-agents.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

async function home(): Promise<LogHome> {
	const fixture = await logHome()
	roots.push(fixture.root)
	return fixture
}

it('reports a child with no recorded ending as unresolved, and isolates conversations', async () => {
	const fixture = await home()
	const parent = await parentSession(fixture)
	const child = await spawnChild(fixture, parent, { description: 'check effects' })
	const other = await parentSession(fixture)
	const index = await fixture.index()

	const history = createSavedAgentHistory({
		index,
		paths: fixture.paths,
		session: { sessionId: parent.sessionId },
	})
	const { agents, omitted } = await history.list()
	expect(agents).toMatchObject([{ sessionId: child.sessionId, status: 'unresolved' }])
	expect(omitted).toBe(0)
	expect((await history.read(child.sessionId)).status).toBe('unresolved')

	const elsewhere = createSavedAgentHistory({
		index,
		paths: fixture.paths,
		session: { sessionId: other.sessionId },
	})
	expect((await elsewhere.list()).agents).toEqual([])
	// Another conversation's child is not this one's to read, and a path is
	// never an id.
	await expect(elsewhere.read(child.sessionId)).rejects.toThrow('No saved agent')
	await expect(history.read('../outside')).rejects.toThrow('session UUID')
})

it('reads back the settled answer, bounded with a marker', async () => {
	const fixture = await home()
	const parent = await parentSession(fixture)
	const child = await spawnChild(fixture, parent, { description: 'long answer' })
	const turnId = generateTurnId()
	await child.writer.beginTurn(turnId, 'write a lot')
	await child.writer.completeTurn(turnId, 'x'.repeat(MAX_SAVED_OUTPUT_CODE_UNITS + 1_000), 10)
	await endChild(parent, child.sessionId, 'completed', 10)

	const saved = await createSavedAgentHistory({
		index: await fixture.index(),
		paths: fixture.paths,
		session: { sessionId: parent.sessionId },
	}).read(child.sessionId)

	expect(saved).toMatchObject({ status: 'completed', outputTruncated: true })
	expect(saved.output).toHaveLength(MAX_SAVED_OUTPUT_CODE_UNITS)
})

it('reports the real final status of a child whose own log settled although the parent never recorded its end', async () => {
	const fixture = await home()
	const parent = await parentSession(fixture)
	const finished = await spawnChild(fixture, parent, { description: 'finished work' })
	const turnId = generateTurnId()
	await finished.writer.beginTurn(turnId, 'do it')
	await finished.writer.completeTurn(turnId, 'done', 10)
	const midway = await spawnChild(fixture, parent, { description: 'midway work' })
	await midway.writer.beginTurn(generateTurnId(), 'still going')

	const history = createSavedAgentHistory({
		index: await fixture.index(),
		paths: fixture.paths,
		session: { sessionId: parent.sessionId },
	})
	const { agents } = await history.list()
	expect(agents.find((agent) => agent.sessionId === finished.sessionId)?.status).toBe('completed')
	expect(agents.find((agent) => agent.sessionId === midway.sessionId)?.status).toBe('unresolved')
	expect((await history.read(finished.sessionId)).status).toBe('completed')
})

it('records earlier turns’ agents once, then only an agent that is new or changed, leaving out this turn’s and stepping aside under pressure', async () => {
	const fixture = await home()
	const parent = await parentSession(fixture)
	const previous = await spawnChild(fixture, parent, { description: 'previous check' })
	const index = await fixture.index()
	const stepFor = () =>
		createSavedAgentsStep(
			createSavedAgentHistory({
				index,
				paths: fixture.paths,
				session: { sessionId: parent.sessionId },
			}),
		)
	const context = {
		sessionId: parent.sessionId,
		turnId: generateTurnId(),
		prepared: { system: 'existing rules' },
		messages: [],
		steps: [],
		stepNumber: 1,
	} as unknown as PrepareStepContext

	// Recorded in the conversation; the system prompt is left alone.
	const first = await stepFor()(context)
	expect(first?.system).toBeUndefined()
	const [entry] = first?.recordedContext ?? []
	expect(entry?.key).toBe(SAVED_AGENTS_KEY)
	expect(entry?.text).toContain('previous check')
	expect(entry?.text).toContain('unresolved')
	// The first entry explains how to read the rows.
	expect(entry?.text).toContain('session id')
	expect(entry?.text).toContain('send_message')

	// The same listing, already in the history: nothing more to say.
	const recorded = createTurnContextEntry(SAVED_AGENTS_KEY, entry?.text ?? '')
	expect(await stepFor()({ ...context, messages: [recorded] })).toBeUndefined()

	// A new agent: only its row, and no guidance again.
	await spawnChild(fixture, parent, { description: 'later check' })
	const next = await stepFor()({ ...context, messages: [recorded] })
	const [delta] = next?.recordedContext ?? []
	expect(delta?.text).toContain('later check')
	expect(delta?.text).not.toContain('previous check')
	expect(delta?.text).not.toContain('send_message')

	// A status change lists that row again.
	await endChild(parent, previous.sessionId, 'completed', 1)
	const changed = await stepFor()({ ...context, messages: [recorded] })
	expect(changed?.recordedContext?.[0]?.text).toContain('previous check')

	// The turn that spawned it is the current one: its children are live.
	expect(await stepFor()({ ...context, turnId: parent.turnId })).toBeUndefined()
	expect(
		await stepFor()({ ...context, contextBudget: { remainingTokens: 100, windowTokens: 1000 } }),
	).toBeUndefined()
})

it.each([200, 201, 1000])(
	'counts every child it leaves out, past the read bound (%i children)',
	async (count) => {
		const fixture = await home()
		const parent = await parentSession(fixture)
		const turnId = generateTurnId()
		const children = Array.from(
			{ length: count },
			(_, i) =>
				({
					sessionId: generateSessionId(),
					parentTurnId: turnId,
					description: `child ${i}`,
					status: 'completed',
					spawnedAt: new Date(1_000_000 + i).toISOString(),
				}) as unknown as ChildSessionSummary,
		)
		const index = {
			refresh: async () => undefined,
			listChildren: async () => children,
		} as unknown as SavedChildIndex
		const { agents, omitted } = await createSavedAgentHistory({
			index,
			paths: fixture.paths,
			session: { sessionId: parent.sessionId },
		}).list()
		expect(agents).toHaveLength(MAX_LISTED_SAVED_AGENTS)
		expect(omitted).toBe(count - MAX_LISTED_SAVED_AGENTS)
	},
)
