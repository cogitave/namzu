import { describe, expect, it } from 'vitest'

import { PERMISSION_MODES, permissionModeDescription } from '../../permissions/mode.js'
import { type SlashContext, renderPermissions, renderStatus, runSlash } from '../slashCommands.js'

function context(over: Partial<SlashContext> = {}): SlashContext {
	return {
		cwd: '/work/project',
		compaction: {
			strategy: 'salience',
			softTarget: 0.5,
			triggerThreshold: 0.7,
			passes: 2,
			clearedResults: 3,
			stubbedNarrations: 1,
			summaries: 1,
			reclaimedTokens: 900,
		},
		jobs: () => [],
		availableTools: () => ['read'],
		sandbox: null,
		mcp: () => ({
			connected: [{ name: 'tickets', tools: ['search_tickets'] }],
			failed: [{ name: 'docs', reason: 'connection closed' }],
		}),
		providerSummary: 'test',
		modelSummary: 'test-model',
		reasoningEffort: { current: () => undefined, levels: undefined },
		usage: {
			totalTokens: 150,
			cost: { totalCost: 0.125, unpricedTokens: 0, cacheDiscount: 0 },
			context: { tokens: 100, windowTokens: 1000, measured: false, windowAssumed: true },
		},
		permissions: {
			currentMode: () => ({ mode: 'prompt', source: 'default' }),
			rules: [],
			approvalLatched: () => false,
			neverPrompted: () => ['read'],
		},
		instructionFiles: [],
		userCommands: [],
		configDebug: null,
		lastAssistantMessageId: () => null,
		...over,
	}
}

function report(command: string, ctx = context()): string {
	const action = runSlash(command, ctx)
	if (action?.kind !== 'message') throw new Error(`Expected report for ${command}`)
	return action.content
}

describe('command summaries and details', () => {
	it.each(['cost', 'context', 'status', 'mcp'])(
		'%s keeps details discoverable and rejects mistyped arguments',
		(command) => {
			const summary = report(`/${command}`)
			expect(summary).toContain(`/${command} ${command === 'mcp' ? 'tools' : 'details'}`)
			expect(report(`/${command} detials`)).toMatch(/^Usage:/)
		},
	)

	it('shows money under Spend and keeps own-run scope distinct from conversation usage', () => {
		expect(renderStatus(context())).toContain('Spend (current or latest run, own calls): $0.1250')
		expect(renderStatus(context())).not.toContain('Spend: Tokens:')
		const details = report('/cost details')
		expect(details).toContain('excluding delegated calls and earlier runs')
		expect(details).toContain('not conversation totals')
		expect(details).not.toContain('only ever grows')
	})

	it('keeps incomplete pricing and blocked spending visible without opening details', () => {
		const ctx = context({
			usage: {
				totalTokens: 150,
				cost: { totalCost: 0.125, unpricedTokens: 50, cacheDiscount: 0 },
				budget: {
					limit: 1000,
					ownTokens: 150,
					treeTokens: 400,
					reservedTokens: 0,
					remainingTokens: 600,
					inFlightRequests: 1,
					unsettledChildren: 0,
					poisoned: true,
				},
			},
		})
		expect(report('/cost', ctx)).toContain('at least $0.1250')
		expect(report('/cost', ctx)).toContain('50 tokens have no known price')
		expect(report('/cost', ctx)).toContain('Including delegated agents: 400 tokens')
		expect(report('/cost', ctx)).toContain('Further spending is blocked')
		expect(renderStatus(ctx)).toContain('at least $0.1250')
	})

	it('keeps estimates honest in the short context view and puts cleanup counters in details', () => {
		const summary = report('/context')
		expect(summary).toContain('(~10%)')
		expect(summary).toContain('Estimated by Namzu; window assumed')
		expect(summary).not.toContain('Tool results cleared:')
		expect(report('/context details')).toContain('Tool results cleared: 3')
		expect(report('/cost')).not.toContain('Context:')
	})

	it('shows connection failures immediately and tool names only on request', () => {
		const summary = report('/mcp')
		expect(summary).toContain('docs: unavailable — connection closed')
		expect(summary).not.toContain('search_tickets')
		expect(report('/mcp tools')).toContain('search_tickets')
		expect(report('/mcp details')).toBe(report('/mcp tools'))
	})
})

describe('permission reports match all selectable modes', () => {
	it.each(PERMISSION_MODES)('%s uses the shared behavior and is accepted directly', (mode) => {
		const ctx = context()
		const permissions = {
			...ctx.permissions,
			currentMode: () => ({ mode, source: 'session' as const }),
		}
		expect(renderPermissions(permissions)).toContain(permissionModeDescription(mode))
		expect(runSlash(`/permissions ${mode}`, ctx)).toEqual({ kind: 'permission-mode', mode })
		expect(report('/permissions invalid', ctx)).toContain('/permissions opens the permission menu')
		expect(report('/permissions invalid', ctx)).not.toContain('prompt|accept-edits')
	})

	it('plan and strict ignore an old approve-all choice while accept-edits honors it', () => {
		for (const mode of ['plan', 'strict', 'accept-edits'] as const) {
			const permissions = {
				...context().permissions,
				currentMode: () => ({ mode, source: 'session' as const }),
				approvalLatched: () => true,
			}
			const text = renderPermissions(permissions)
			if (mode === 'accept-edits') expect(text).toContain('approved automatically')
			else {
				expect(text).toContain(permissionModeDescription(mode))
				expect(text).not.toContain('approved automatically')
			}
		}
	})

	it('keeps raw rule and exemption lists behind details', () => {
		const permissions = {
			...context().permissions,
			rules: [{ type: 'deny_by_name' as const, toolNames: ['write'] }],
		}
		expect(renderPermissions(permissions)).not.toContain('write')
		expect(renderPermissions(permissions, true)).toContain('write')
		expect(report('/permissions details')).toContain('Tools exempt from ordinary prompts: read')
	})
})
