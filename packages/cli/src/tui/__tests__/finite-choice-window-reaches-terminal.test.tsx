/**
 * Long finite choices must keep the absolute cursor inside the real viewport.
 *
 * Index-only tests cannot see this defect: both model and resume handlers can
 * move to item 13 while Ink still draws a list taller than the terminal, so
 * the selected row has scrolled above the screen. This drives the production
 * renderer and reads the emulated terminal rather than a frame string.
 */

import { afterEach, expect, it, vi } from 'vitest'

import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import type { AgentSession, ModelListing } from '../agent.js'
import { Picker } from '../Picker.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

const DETECTED = [
	{
		entry: {
			id: 'openai',
			label: 'A Provider',
			defaultModel: 'model-default',
			requiresApiKey: true,
			envVars: ['A_KEY'],
			constructible: true,
		},
		source: { kind: 'env', envName: 'A_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	} as unknown as DetectedProvider,
]

const MODELS: ModelListing = {
	kind: 'ok',
	models: Array.from({ length: 30 }, (_, index) => ({
		id: `model-${index + 1}`,
		name: `Model ${index + 1}`,
	})),
}

const RECENT = Array.from({ length: 30 }, (_, index) => ({
	id: `ses_${index + 1}`,
	title: `Conversation ${index + 1}`,
	updatedAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
	count: 2,
	named: false,
}))

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	listRecent: async () => RECENT,
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({
			preferences: PREFS,
			needsRepickReason: null,
			detected: [],
		}),
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
			providerSummary: 'A Provider',
			modelSummary: 'model-default',
			toolNames: () => [],
			errorHint: null,
			errorKind: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			agentIds: [],
			configNotices: [],
			approvalLatched: () => false,
			promptExemptTools: () => [],
			compact: async () => null,
			resumeDurable: async () => {
				throw new Error('not used by the finite-choice test')
			},
			close: async () => {},
			send: async function* () {},
		}),
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
const mounted: Screen[] = []

afterEach(async () => {
	for (const screen of mounted.splice(0)) await screen.unmount()
})

async function waitUntil(screen: Screen, predicate: () => boolean, attempts = 100): Promise<void> {
	for (let index = 0; index < attempts && !predicate(); index += 1) {
		await screen.waitForRender()
	}
	expect(predicate()).toBe(true)
}

function viewport(screen: Screen): string {
	return screen.viewport().join('\n')
}

it('keeps a model reached beyond the first page visible and submits its absolute id', async () => {
	const onSubmit = vi.fn()
	const screen = await renderToScreen(
		<Picker
			detected={DETECTED}
			onSubmit={onSubmit}
			onCancel={vi.fn()}
			describeModels={async () => MODELS}
		/>,
		{ cols: 100, rows: 14 },
	)
	mounted.push(screen)

	screen.press('\r')
	await waitUntil(screen, () => viewport(screen).includes('Choose a model'))
	for (let index = 0; index < 12; index += 1) {
		screen.press('\x1B[B')
		await screen.waitForRender()
	}

	const output = viewport(screen)
	expect(output).toContain('❯ 13. Model 12')
	expect(output).toContain('13/31')
	expect(output).not.toContain('31. Model 30')

	screen.press('\r')
	await waitUntil(screen, () => onSubmit.mock.calls.length === 1)
	expect(onSubmit.mock.calls[0]?.[0]).toEqual({ provider: 'openai', model: 'model-12' })
})

it('keeps App resume navigation on the selected conversation instead of an offscreen row', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 16 })
	mounted.push(screen)
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('Connected to A Provider'))

	screen.press('/resume')
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => viewport(screen).includes('Resume a conversation'))
	for (let index = 0; index < 12; index += 1) {
		screen.press('\x1B[B')
		await screen.waitForRender()
	}

	const output = viewport(screen)
	expect(output).toContain('› Conversation 13')
	expect(output).toContain('13/30')
	expect(output).not.toContain('Conversation 30')
})
