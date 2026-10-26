/**
 * The agent is told what day it is and which branch it is on, in the request
 * that is actually sent. The facts ride in an environment reminder, not in the
 * cached system prompt, so a new day or a checkout cannot re-key the prompt.
 *
 * A composer test proves the sentence is well formed and nothing about whether
 * anyone says it. The failure this invites is the block existing, being
 * correct, and never being joined into the prompt — which is silent: the model
 * keeps answering from its training cut-off, confidently, and every date it
 * writes into a changelog or a frontmatter field looks like an ordinary answer.
 *
 * So this starts at a REAL repository on disk and ends at the `systemPrompt`
 * `query()` was called with, and it drives the sub-agent path as well, because
 * a delegated task dating a file from the wrong year is the same defect one
 * hop further out.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import {
	type AgentDefinition,
	AgentRegistry,
	type Message,
	createRuntimeContextMessage,
	createUserMessage,
} from '@namzu/sdk'

import { localIsoDate } from '../context/environment.js'
import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'

const queryCalls: Record<string, unknown>[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Record<string, unknown>) => {
			queryCalls.push(params)
			return (async function* () {})()
		},
	}
})

let root: string
let repo: string

beforeEach(() => {
	queryCalls.length = 0
	root = mkdtempSync(join(tmpdir(), 'namzu-env-turn-'))
	repo = join(root, 'repo')
	mkdirSync(repo, { recursive: true })
	execFileSync('git', ['init', '--quiet'], { cwd: repo })
	execFileSync('git', ['checkout', '-q', '-b', 'feature/parser'], { cwd: repo })
})

afterEach(() => {
	vi.restoreAllMocks()
	removeTempDir(root)
})

const prefs = {
	version: 3,
	providers: [{ id: 'anthropic' }],
	subagents: { active: [] },
} as Preferences

function detectedAnthropic(): DetectedProvider[] {
	return [
		{
			entry: {
				id: 'anthropic',
				label: 'Anthropic',
				defaultModel: 'claude-sonnet-4-5',
				requiresApiKey: true,
				envVars: ['ANTHROPIC_API_KEY'],
			},
			source: 'env',
			apiKey: 'sk-ant-not-a-real-key',
			alternatives: [],
		} as unknown as DetectedProvider,
	]
}

async function openSessionIn(cwd: string) {
	const { createAgentSession } = await import('../tui/agent.js')
	return createAgentSession(prefs, detectedAnthropic(), { cwd })
}

type QueryCall = {
	systemPrompt?: string
	reminders?: (context: { messages: readonly Message[] }) => Promise<readonly string[] | undefined>
}

/** What a request's reminder source says over a conversation. */
async function reminded(call: unknown, messages: readonly Message[]): Promise<readonly string[]> {
	return (await (call as QueryCall).reminders?.({ messages })) ?? []
}

async function drive(cwd: string): Promise<{ systemPrompt: string; reminders: string }> {
	const session = await openSessionIn(cwd)
	for await (const _ of session.send([{ role: 'user', content: 'hi', timestamp: 0 }])) {
		// drain
	}
	expect(queryCalls.length, 'the turn must have reached query()').toBe(1)
	return {
		systemPrompt: String(queryCalls[0]?.systemPrompt ?? ''),
		reminders: (await reminded(queryCalls[0], [createUserMessage('hi')])).join('\n'),
	}
}

describe('where and when the agent is', () => {
	it("is told today's date by a reminder, and the system prompt does not carry it", async () => {
		const today = localIsoDate(new Date())
		const { systemPrompt, reminders } = await drive(repo)

		expect(reminders).toContain(today)
		expect(systemPrompt).not.toContain(today)
	})

	it('names the branch that is actually checked out', async () => {
		const { systemPrompt, reminders } = await drive(repo)

		expect(reminders).toContain('feature/parser')
		expect(systemPrompt).not.toContain('feature/parser')
	})

	it('follows the branch when it changes mid-session, without touching the system prompt', async () => {
		// The reason this is read per turn. An agent that checks out a branch
		// itself — an ordinary thing to be asked to do — would otherwise spend
		// the rest of the session asserting the branch it started on, which is
		// worse than never having been told.
		const session = await openSessionIn(repo)
		for await (const _ of session.send([{ role: 'user', content: 'hi', timestamp: 0 }])) {
			// drain
		}
		execFileSync('git', ['checkout', '-q', '-b', 'feature/lexer'], { cwd: repo })
		for await (const _ of session.send([{ role: 'user', content: 'again', timestamp: 0 }])) {
			// drain
		}

		const first = await reminded(queryCalls[0], [createUserMessage('hi')])
		expect(first.join('\n')).toContain('feature/parser')
		const heard = [
			createUserMessage('hi'),
			...first.map((text) => createRuntimeContextMessage(text, 'reminder')),
			createUserMessage('again'),
		]
		const second = (await reminded(queryCalls[1], heard)).join('\n')
		expect(second).toContain('feature/lexer')
		expect(second).toContain('needs no announcement')
		expect(String(queryCalls[1]?.systemPrompt)).toBe(String(queryCalls[0]?.systemPrompt))
	})

	it('sends the same system prompt whatever permission mode the turn runs under', async () => {
		const { createAgentSession } = await import('../tui/agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), {
			cwd: repo,
			planApproval: true,
			reminders: true,
		})
		for (const permissionMode of ['prompt', 'plan', 'auto', 'bypass'] as const) {
			for await (const _ of session.send([{ role: 'user', content: 'hi', timestamp: 0 }], {
				permissionMode,
			})) {
				// drain
			}
		}
		expect(queryCalls).toHaveLength(4)
		const prompts = new Set(queryCalls.map((call) => String(call.systemPrompt)))
		expect(prompts.size).toBe(1)
		const planReminder = (await reminded(queryCalls[1], [createUserMessage('hi')])).join('\n')
		expect(planReminder).toContain('Plan mode is on')
		const bypassReminder = (await reminded(queryCalls[3], [createUserMessage('hi')])).join('\n')
		expect(bypassReminder).toContain('The bypass permission mode is on.')
	})

	it('says a plain directory is not a repository', async () => {
		const plain = join(root, 'plain')
		mkdirSync(plain)

		const { reminders } = await drive(plain)

		expect(reminders).toContain('not a git repository')
	})

	it('reaches a sub-agent too', async () => {
		const registered: AgentDefinition[] = []
		vi.spyOn(AgentRegistry.prototype, 'register').mockImplementation((def) => {
			for (const d of Array.isArray(def) ? def : [def]) registered.push(d)
		})

		await openSessionIn(repo)

		const general = registered.find((d) => d.info.id === 'general-purpose')
		if (!general?.configBuilder) {
			throw new Error('the sub-agent runtime did not stand up — this test proves nothing')
		}
		const config = (await general.configBuilder({})) as { systemPrompt?: string }
		expect(config.systemPrompt).toContain('feature/parser')
		expect(config.systemPrompt).toContain(localIsoDate(new Date()))
		// A sub-agent has no operator and no mode reminder: it is told whose
		// decision a refused or asked call is, not that it may ask the user.
		expect(config.systemPrompt).toContain(
			'follow the permission mode of the session that started you',
		)
		expect(config.systemPrompt).toContain('You have no one to ask yourself')
		expect(config.systemPrompt).not.toContain('may ask the user before they run')
	})

	it('tells the model about a mode change once, as a reminder after the history', async () => {
		const { createAgentSession } = await import('../tui/agent.js')
		const session = await createAgentSession(prefs, detectedAnthropic(), {
			cwd: repo,
			reminders: true,
		})
		const modes = ['prompt', 'classify', 'strict', 'bypass', 'prompt'] as const
		for (const permissionMode of modes) {
			for await (const _ of session.send([{ role: 'user', content: 'hi', timestamp: 0 }], {
				permissionMode,
			})) {
				// drain
			}
		}
		expect(queryCalls).toHaveLength(modes.length)
		// System blocks do not move with the mode.
		expect(new Set(queryCalls.map((call) => String(call.systemPrompt))).size).toBe(1)
		// The kernel's own "Approval policy changed" message is off: the
		// reminder is the one place the model hears it.
		for (const call of queryCalls) {
			expect(
				(call as { announceApprovalPolicyChange?: boolean }).announceApprovalPolicyChange,
			).toBe(false)
		}
		const said = async (i: number) =>
			(await reminded(queryCalls[i], [createUserMessage('hi')])).join('\n')
		const auto = await said(1)
		expect(auto.match(/permission mode is on/g)).toHaveLength(1)
		expect(auto).toContain('The auto permission mode is on.')
		expect(auto).toContain('checked automatically')
		expect(auto).not.toContain('second model')
		expect(await said(2)).toContain('The strict permission mode is on.')
		expect(await said(3)).toContain('Permission prompts are off in this mode')
		const prompt = await said(0)
		expect(prompt).not.toContain('permission mode is on')
	})
})
