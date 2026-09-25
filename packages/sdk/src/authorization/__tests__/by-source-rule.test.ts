import { describe, expect, it } from 'vitest'

import type { ToolSourceRef } from '../../toolsets/types.js'
import {
	AuthorizationGateConfigSchema,
	type AuthorizationRule,
} from '../../types/authorization/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { AuthorizationGate } from '../gate.js'

const server: ToolSourceRef = {
	id: 'mcp:github',
	kind: 'mcp_server',
	server: 'github',
	readOnlyHintTrusted: false,
}
const otherServer: ToolSourceRef = {
	id: 'mcp:calendar',
	kind: 'mcp_server',
	server: 'calendar',
	readOnlyHintTrusted: false,
}

function gate(rules: AuthorizationRule[], allowReadOnlyTools = false): AuthorizationGate {
	return new AuthorizationGate(
		{
			enabled: true,
			rules,
			allowReadOnlyTools,
			denyDangerousPatterns: false,
			logDecisions: false,
		},
		NOOP_LOGGER,
	)
}

function evaluate(g: AuthorizationGate, toolSource?: ToolSourceRef, toolDef?: ToolDefinition) {
	return g.evaluate({ toolName: 'mcp__github__read', toolInput: {}, toolDef, toolSource })
}

describe('by_source authorization rules', () => {
	it.each(['allow', 'deny', 'review'] as const)('%s applies to an owning source id', (decision) => {
		const rule: AuthorizationRule = { type: 'by_source', sources: ['mcp:git*'], decision }
		const g = gate([rule])
		const matched = evaluate(g, server)
		expect(matched.decision).toBe(decision)
		expect(matched.matchedRule).toEqual(rule)
		expect(matched.reason).toContain('mcp:git*')
		expect(evaluate(g, otherServer).matchedRule).toBeNull()
		expect(evaluate(g).matchedRule).toBeNull()
	})

	it('matches the whole source id, including a plugin-owned MCP server', () => {
		const g = gate([
			{ type: 'by_source', sources: ['mcp:db', 'plugin:acme/mcp:*'], decision: 'deny' },
		])
		expect(
			evaluate(g, { id: 'plugin:acme/mcp:db', kind: 'mcp_server', server: 'db' }).decision,
		).toBe('deny')
		expect(evaluate(g, server).matchedRule).toBeNull()
	})

	it('an explicit source review runs before the default read-only allowance', () => {
		const g = gate([{ type: 'by_source', sources: ['mcp:github'], decision: 'review' }], true)
		const readOnly = {
			name: 'mcp__github__read',
			isReadOnly: () => true,
		} as unknown as ToolDefinition
		const matched = evaluate(g, server, readOnly)
		expect(matched.decision).toBe('review')
		expect(matched.matchedRule?.type).toBe('by_source')
	})

	it('keeps first-match rule order', () => {
		const sourceRule: AuthorizationRule = {
			type: 'by_source',
			sources: ['mcp:github'],
			decision: 'review',
		}
		const nameRule: AuthorizationRule = { type: 'deny_by_name', toolNames: ['mcp__github__read'] }
		expect(evaluate(gate([nameRule, sourceRule]), server).decision).toBe('deny')
		expect(evaluate(gate([sourceRule, nameRule]), server).decision).toBe('review')
	})

	it('rejects an empty source pattern or an unrecognised decision', () => {
		const config = {
			enabled: true,
			rules: [{ type: 'by_source', sources: [''], decision: 'allow' }],
		}
		expect(AuthorizationGateConfigSchema.safeParse(config).success).toBe(false)
		expect(
			AuthorizationGateConfigSchema.safeParse({
				...config,
				rules: [{ type: 'by_source', sources: ['mcp:*'], decision: 'approve' }],
			}).success,
		).toBe(false)
		expect(
			AuthorizationGateConfigSchema.safeParse({
				...config,
				rules: [{ type: 'by_source', sources: [], decision: 'deny' }],
			}).success,
		).toBe(false)
	})
})
