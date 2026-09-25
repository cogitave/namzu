import { describe, expect, it } from 'vitest'

import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { createBrowserTools } from '../../../tools/builtins/browser.js'
import type { Toolset } from '../../../toolsets/types.js'
import type { AuthorizationGateConfig } from '../../../types/authorization/index.js'
import type {
	BrowserActAction,
	BrowserHost,
	BrowserObserveAction,
} from '../../../types/browser/index.js'
import type { HITLDecisionRequest } from '../../../types/hitl/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * Site rules are argument patterns over `browser.url` and
 * `browser_act.origin`. They only mean something if the value they test is
 * the value the browser loads. These drive the real kernel — registry,
 * AuthorizationGate, review — with the model writing non-canonical
 * spellings, and check what the gate decided and what the host received.
 */

const GITHUB = '(?:[/?#]|$)'
const gateConfig: AuthorizationGateConfig = {
	enabled: true,
	rules: [
		{
			type: 'argument_pattern',
			toolNames: ['browser'],
			argument: 'url',
			pattern: `^https://github\\.com${GITHUB}`,
			decision: 'allow',
		},
		{
			type: 'argument_pattern',
			toolNames: ['browser_act'],
			argument: 'origin',
			pattern: '^https://github\\.com$',
			decision: 'review',
		},
		{ type: 'deny_by_name', toolNames: ['browser', 'browser_act'] },
	],
	allowReadOnlyTools: false,
	denyDangerousPatterns: false,
	logDecisions: false,
}

function fixture() {
	const observed: BrowserObserveAction[] = []
	const acted: BrowserActAction[] = []
	const page = {
		origin: 'https://github.com',
		url: 'https://github.com/',
		title: 'GitHub',
		tab: 't1',
	}
	const host: BrowserHost = {
		id: 'fake',
		capabilities: { engine: 'fake', headless: true, screenshot: true, upload: false },
		async observe(action) {
			observed.push(action)
			return { page }
		},
		async act(action) {
			if (action.origin !== page.origin) throw new Error('origin check failed')
			acted.push(action)
			return { page }
		},
	}
	const tools = testToolset(...createBrowserTools(host).map((tool) => tool as ToolDefinition))
	return { observed, acted, tools }
}

async function runTurn(
	toolCalls: { id: string; name: string; args: Record<string, unknown> }[],
	tools: Toolset,
	review?: (request: HITLDecisionRequest) => Promise<unknown>,
) {
	const sessionLog = new InMemorySessionLog({ sessionId: generateSessionId() })
	const events: SessionEvent[] = []
	const provider = new MockLLMProvider({ turns: [{ toolCalls }, { text: 'done' }] })
	await drainQuery(
		{
			provider,
			toolsets: [tools],
			sessionLog,
			agentId: 'browser-site-rules',
			agentName: 'Browser site rules',
			messages: [{ role: 'user' as const, content: 'browse' }],
			workingDirectory: process.cwd(),
			turnConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 5_000, maxIterations: 4 },
			projectId: generateProjectId(),
			sessionId: sessionLog.sessionId,
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			authorizationGate: gateConfig,
			...(review ? { resumeHandler: review as never } : {}),
		},
		(event) => {
			events.push(event)
		},
	)
	return events
}

function completed(events: SessionEvent[], toolName: string) {
	return events.filter(
		(e): e is Extract<SessionEvent, { type: 'tool_completed' }> =>
			e.type === 'tool_completed' && e.toolName === toolName,
	)
}

describe('browser site rules through the real gate', () => {
	it('allows a non-canonical spelling of an allowed site, and loads the canonical one', async () => {
		const { observed, tools } = fixture()
		const events = await runTurn(
			[
				{
					id: 'c1',
					name: 'browser',
					args: { action: 'navigate', url: 'HTTPS://GitHub.com.:443/search?q=a&type=code' },
				},
			],
			tools,
		)
		expect(observed).toEqual([
			{ action: 'navigate', url: 'https://github.com/search?q=a&type=code' },
		])
		expect(completed(events, 'browser')[0]?.isError).toBe(false)
	})

	it('denies a lookalike host the allow pattern must not match', async () => {
		for (const url of [
			'https://github.com.evil.example/',
			'https://evil.example/?https://github.com',
			'https://github.com@evil.example/',
			'https://gіthub.com/',
		]) {
			const { observed, tools } = fixture()
			const events = await runTurn(
				[{ id: 'c1', name: 'browser', args: { action: 'navigate', url } }],
				tools,
			)
			expect(observed, url).toEqual([])
			expect(completed(events, 'browser')[0]?.isError, url).toBe(true)
		}
	})

	it('sends an act on a review site to a person, showing the canonical origin', async () => {
		const { acted, tools } = fixture()
		let request: HITLDecisionRequest | undefined
		await runTurn(
			[
				{
					id: 'c1',
					name: 'browser_act',
					args: { action: 'click', ref: 'e3', origin: 'HTTPS://GITHUB.COM:443/' },
				},
			],
			tools,
			async (pending) => {
				if (pending.type !== 'tool_review') return { action: 'continue' }
				request = pending
				return { action: 'approve_tools' }
			},
		)
		expect(request).toEqual(
			expect.objectContaining({
				type: 'tool_review',
				toolCalls: [
					expect.objectContaining({
						name: 'browser_act',
						input: { action: 'click', ref: 'e3', origin: 'https://github.com' },
						authorization: expect.objectContaining({ decision: 'review', explicitReview: true }),
					}),
				],
			}),
		)
		expect(acted).toEqual([{ action: 'click', ref: 'e3', origin: 'https://github.com' }])
	})

	it('does not act when the person says no', async () => {
		const { acted, tools } = fixture()
		await runTurn(
			[
				{
					id: 'c1',
					name: 'browser_act',
					args: { action: 'click', ref: 'e3', origin: 'https://github.com' },
				},
			],
			tools,
			async (pending) =>
				pending.type === 'tool_review'
					? { action: 'reject_tools', feedback: 'no' }
					: { action: 'continue' },
		)
		expect(acted).toEqual([])
	})

	it('denies an act on a site no rule names', async () => {
		const { acted, tools } = fixture()
		const events = await runTurn(
			[
				{
					id: 'c1',
					name: 'browser_act',
					args: { action: 'click', ref: 'e3', origin: 'https://evil.example' },
				},
			],
			tools,
			async (pending) =>
				pending.type === 'tool_review' ? { action: 'approve_tools' } : { action: 'continue' },
		)
		expect(acted).toEqual([])
		expect(completed(events, 'browser_act')[0]?.result).toMatch(/authorization gate/i)
	})

	it('pauses the turn, before the model is called again, when the page needs a person', async () => {
		const host: BrowserHost = {
			id: 'fake',
			capabilities: { engine: 'fake', headless: false, screenshot: true, upload: false },
			async observe() {
				throw {
					code: 'browser_human_required',
					reason: 'sign-in',
					origin: 'https://github.com',
					profile: 'work',
					loginCommand: 'namzu browser login work https://github.com/login',
					message: 'sign-in page',
				}
			},
			async act() {
				throw new Error('not reached')
			},
		}
		const tools = testToolset(...createBrowserTools(host).map((tool) => tool as ToolDefinition))
		const events = await runTurn(
			[
				{
					id: 'c1',
					name: 'browser',
					args: { action: 'navigate', url: 'https://github.com/login' },
				},
			],
			tools,
		)
		const paused = events.filter(
			(e): e is Extract<SessionEvent, { type: 'turn_paused' }> => e.type === 'turn_paused',
		)
		expect(paused).toHaveLength(1)
		expect(paused[0]?.handoff).toEqual({
			kind: 'human-required',
			reason: 'https://github.com is showing a sign-in page',
			detail: {
				tool: 'browser',
				cause: 'sign-in',
				origin: 'https://github.com',
				profile: 'work',
				loginCommand: 'namzu browser login work https://github.com/login',
			},
		})
		// The model's second turn ("done") never ran.
		expect(events.some((e) => e.type === 'turn_completed')).toBe(false)
	})
})
