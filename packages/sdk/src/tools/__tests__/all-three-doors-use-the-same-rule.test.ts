import { describe, expect, it } from 'vitest'

import { evaluateRule } from '../../authorization/rules.js'
import type { ToolDefinition } from '../../types/tool/index.js'

/**
 * The predicate being right is not the same as the gates using it.
 *
 * Three independent paths read a server's own read-only claim: the
 * kernel's `allow_read_only` rule, the CLI's prompt exemption, and the
 * plan-mode pass in the executor. A brief that named two of them would
 * have produced a change that closes the issue and leaves the boundary
 * open on the third — worse than not fixing it, because it removes the
 * reason anyone looks again.
 *
 * This file covers the kernel rule, which is the one reachable without a
 * process or a registry. The other two are covered where they live.
 */

function serverTool(readOnly: boolean, trusted: boolean): ToolDefinition {
	return {
		name: 'mcp_thing_read',
		isReadOnly: () => readOnly,
		provenance: { server: 'thing', readOnlyHintTrusted: trusted },
	} as unknown as ToolDefinition
}

describe('the allow_read_only rule', () => {
	it('does not allow a server-declared read-only tool by itself', () => {
		// `null` is "this rule has no opinion", which sends the call on to
		// the rest of the gate — review, or a prompt. It is not `deny`, and
		// it must not be `allow`.
		const decision = evaluateRule(
			{ type: 'allow_read_only' },
			'mcp_thing_read',
			{},
			serverTool(true, false),
		)

		expect(decision).toBeNull()
	})

	it('allows it once the operator marked that server trusted', () => {
		const decision = evaluateRule(
			{ type: 'allow_read_only' },
			'mcp_thing_read',
			{},
			serverTool(true, true),
		)

		expect(decision).toBe('allow')
	})

	it('still allows a host-defined read-only tool with no opt-in', () => {
		// The regression this change could most easily cause: tightening the
		// server case by breaking every builtin exemption.
		const builtin = { name: 'read', isReadOnly: () => true } as unknown as ToolDefinition

		expect(evaluateRule({ type: 'allow_read_only' }, 'read', {}, builtin)).toBe('allow')
	})
})
