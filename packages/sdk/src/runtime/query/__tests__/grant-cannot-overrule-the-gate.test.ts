import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { AuthorizationGateConfig } from '../../../types/authorization/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * A grant and a gate are different authorities. A grant records that the
 * USER said yes to a shape of call; the gate encodes what the OPERATOR
 * forbids. The grant check used to run first and RETURN, so a remembered
 * approval skipped the gate entirely — and because a tool-scoped grant
 * matches any arguments, approving one harmless invocation of a tool
 * authorised every other invocation of it, past a rule written to stop
 * exactly that.
 */

registerMock()

const ran: string[] = []

function tools() {
	const registry = new ToolRegistry()
	registry.register(
		defineTool({
			name: 'shell',
			description: 'run a command',
			inputSchema: z.object({ command: z.string() }),
			category: 'shell',
			permissions: ['shell_execute'],
			readOnly: false,
			destructive: true,
			concurrencySafe: false,
			execute: async (input) => {
				ran.push((input as { command: string }).command)
				return { success: true, output: 'done' }
			},
		}),
	)
	return registry
}

/** Operator policy: this one command is forbidden, whoever asks. */
const gate: AuthorizationGateConfig = {
	enabled: true,
	rules: [
		{ type: 'custom_pattern', pattern: 'rm -rf', target: 'args', decision: 'deny' },
		{ type: 'allow_by_name', toolNames: ['shell'] },
	],
	allowReadOnlyTools: false,
	denyDangerousPatterns: false,
	logDecisions: false,
}

const call = (command: string): MockTurn => ({
	toolCalls: [{ id: 'c1', name: 'shell', args: { command } }],
	finishReason: 'tool_calls',
})

/**
 * One run, two tool-calling turns. The grant has to be LIVE for the
 * second call — a `ToolGrantSet` is per-run, so approving in one run and
 * calling in another proves nothing about whether a grant can overrule
 * the gate.
 */
async function run(commands: readonly string[]) {
	ran.length = 0
	const turns: MockTurn[] = [...commands.map(call), { text: 'done' }]

	await drainQuery({
		provider: new MockLLMProvider({ turns }),
		tools: tools(),
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user', content: 'go' }],
		workingDirectory: process.cwd(),
		runConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 30_000, maxIterations: 5 },
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		verificationGate: gate,
		// The approver says "remember: this tool" — the scope the docs
		// recommend for a tool that would otherwise re-prompt forever.
		resumeHandler: async () => ({ action: 'approve_tools', remember: ['shell'] }),
	})

	return ran.slice()
}

describe('a call the operator denies', () => {
	it('does not run just because the same run approved this tool earlier', async () => {
		// Turn one is harmless and earns a tool-wide grant. Turn two is the
		// call the gate exists to stop, and the grant covers it by name.
		expect(await run(['git status', 'rm -rf /'])).toEqual(['git status'])
	})

	it('still runs what the gate allows, without re-prompting', async () => {
		// The fix must not turn every grant back into a prompt; that noise
		// is what the grant was built to end.
		expect(await run(['git status', 'git log'])).toEqual(['git status', 'git log'])
	})

	it('denies the same call when no grant exists at all', async () => {
		expect(await run(['rm -rf /'])).toEqual([])
	})
})
