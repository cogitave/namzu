/**
 * A reply streamed with a tool call, and the tool's own screen after it.
 *
 * The kernel hands this loop a tool's start only when its batch settles, so
 * while the `schedule` tool asks the operator to confirm a job, the reply the
 * model streamed with the call is still pending. A pending reply holds every
 * row after it out of scrollback, and the confirmation — taller than the
 * screen — was drawn in the redrawable tail with its top cut off: the job,
 * the model, the budget and its warnings were never on screen while the
 * operator was asked about them. The tool's screen now closes the reply first.
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, SendOptions } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const root = mkdtempSync(join(tmpdir(), 'namzu-tool-screen-'))
const home = join(root, 'home')
const project = join(root, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(project, { recursive: true })
process.env.NAMZU_HOME = home

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai', model: 'gpt-5' }],
	subagents: { active: [] },
}
let tools: readonly ToolDefinition[] = []

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences: PREFS, needsRepickReason: null, detected: [] }),
		createAgentSession: async (
			_prefs: unknown,
			_detected: unknown,
			options: { readonly extraTools?: readonly ToolDefinition[] },
		): Promise<AgentSession> => {
			tools = options.extraTools ?? []
			return {
				hasProvider: true,
				sandbox: { unconfined: true, enforced: [], required: [] },
				compact: async () => null,
				providerSummary: 'a-provider',
				modelSummary: 'a-model',
				toolNames: () => ['schedule'],
				errorHint: null,
				errorKind: null,
				instructionFiles: [],
				skippedInstructionFiles: [],
				mcpConnected: [],
				mcpFailed: [],
				agentIds: [],
				configNotices: [],
				resumeDurable: async () => {
					throw new Error('not used here')
				},
				resumePaused: () => {
					throw new Error('not used here')
				},
				close: async () => {},
				approvalLatched: () => false,
				promptExemptTools: () => [],
				send: async function* (_messages, opts?: SendOptions): AsyncIterable<AgentEvent> {
					// The reply streamed with the call, cut mid-sentence as a stream is.
					yield { kind: 'delta', text: 'Her 5 dakikada bir paylaşım yapacak görevi' }
					await opts?.onPermission?.({
						toolCalls: [
							{ id: 'sch', name: 'schedule', input: { action: 'create' }, isDestructive: false },
						],
					})
					// The tool runs, and asks, before its start reaches this loop.
					const tool = tools.find((t) => t.name === 'schedule')
					const result = await tool?.execute(
						{
							action: 'create',
							name: 'post',
							prompt: 'Post good morning',
							when: 'every 5m',
							permissions: {
								preset: 'read-only',
								unmatched: 'park',
								browser: { profile: 'social', sites: { 'http://localhost:8123': 'act' } },
							},
							budget: { maxIterations: 1, tokenBudget: 4000 },
						},
						{} as never,
					)
					yield {
						kind: 'tool-start',
						toolUseId: 'sch',
						toolName: 'schedule',
						summary: 'Propose scheduled job',
					}
					yield {
						kind: 'tool-end',
						toolUseId: 'sch',
						toolName: 'schedule',
						summary: String(result?.output || result?.error),
						isError: result?.success !== true,
					}
					yield { kind: 'done', stopReason: 'end_turn' }
				},
			}
		},
	}
})

const { App } = await import('../App.js')
let mounted: Screen | null = null
afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

async function until(screen: Screen, check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 600 && !check(); i++) await screen.waitForRender()
	if (!check()) throw new Error(`${what} never appeared`)
}

it('shows the whole confirmation, and the reply before it, while the operator is asked', async () => {
	const ctx: TuiContext = { cwd: project, version: '0.0.0-test' }
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 120, rows: 42, scrollback: 500 })
	mounted = screen
	await until(screen, () => screen.viewport().join('\n').includes('Type a message'), 'the composer')
	for (const ch of 'post every 5m') {
		screen.press(ch)
		await screen.waitForRender()
	}
	screen.press('\r')
	await until(screen, () => screen.viewport().join('\n').includes('Do you want'), 'the review')
	await new Promise((resolve) => setTimeout(resolve, 700))
	screen.press('y')
	await until(
		screen,
		() => screen.viewport().join('\n').includes('Create the scheduled job'),
		'the confirmation',
	)
	const everything = screen.scrollback().join('\n')
	expect(everything).toContain('Her 5 dakikada bir paylaşım yapacak görevi')
	expect(everything).toContain('PROPOSED BY THE MODEL')
	expect(everything).toContain('Model       openai/gpt-5')
	expect(everything).toContain('Budget      4,000 tokens, 1 iterations')
	expect(everything).toContain('Warning     4,000 tokens may not cover')
})
