/** A durable scheduled result reaches its source screen, never the model history. */

import { type Message, generateScheduleRunId } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import {
	closeSessions,
	loadConversation,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'
import { deliverRunToSource } from '../../schedule/delivery.js'
import { confirmedJob, sandbox } from '../../schedule/__tests__/fixtures.js'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import { type Screen, renderToScreen } from './support/screen.js'

const sent: Message[][] = []
vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../agent.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../agent.js')>()),
	probeAgentSession: async () => ({
		preferences: { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } },
		needsRepickReason: null,
		credentialGap: null,
		detected: [],
	}),
	createAgentSession: async () =>
		fakeAgentSession({
			send: async function* (messages) {
				sent.push([...messages])
				yield { kind: 'delta', text: 'Follow-up received.' }
				yield { kind: 'done', stopReason: 'end_turn' }
			},
		}),
}))

const { App } = await import('../App.js')

afterEach(() => {
	sent.length = 0
	vi.unstubAllEnvs()
})

async function until(screen: Screen, predicate: () => boolean): Promise<void> {
	// Settle actual renders and filesystem work; Vitest owns the hang timeout.
	while (!predicate()) {
		await screen.waitForRender()
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
}

it('renders the saved result on resume and sends only authored messages on the next turn', async () => {
	const box = sandbox()
	vi.stubEnv('NAMZU_HOME', box.home)
	const sessions = await openSessions(box.project, { stateRoot: box.home })
	let screen: Screen | undefined
	try {
		const sessionId = await startConversation(sessions)
		const delivery = {
			kind: 'source-conversation' as const,
			sessionId,
			projectSlug: sessions.slug,
			projectId: sessions.projectId,
			tenantId: sessions.tenantId,
		}
		const job = confirmedJob(box, { delivery })
		expect(
			await deliverRunToSource(box.paths, job, {
				v: 1,
				kind: 'schedule-run-result',
				jobId: job.id,
				runId: generateScheduleRunId(),
				status: 'completed',
				exitCode: 0,
				startedAt: '2026-09-30T09:00:00.000Z',
				endedAt: '2026-09-30T09:00:03.000Z',
				summary: 'Three new issues need attention.',
			}),
		).toEqual({ kind: 'delivered' })
		screen = await renderToScreen(
			<App ctx={{ cwd: box.project, version: 'test', initialConversationId: sessionId }} />,
			{ cols: 100, rows: 32, scrollback: 300 },
		)
		const current = screen
		const painted = () => current.scrollback().join('\n')
		await until(current, () => painted().includes('Three new issues need attention.'))
		expect(painted()).toContain('Scheduled: nightly · completed')
		expect(await loadConversation(sessions, sessionId)).toEqual([])
		await until(current, () => painted().includes('Type a message'))
		current.press('what should I do next?')
		await current.waitForRender()
		current.press('\r')
		await until(current, () => sent.length === 1)
		expect(sent[0]?.map(({ role, content }) => ({ role, content }))).toEqual([
			{ role: 'user', content: 'what should I do next?' },
		])
		await until(current, () => painted().includes('Follow-up received.'))
	} finally {
		await screen?.unmount()
		closeSessions(sessions)
		box.cleanup()
	}
}, 30_000) // Real session files, SQLite and the production terminal renderer.
