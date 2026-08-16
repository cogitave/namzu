import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { AuthorizationGateConfig } from '../../../types/authorization/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * `verificationGate` became `authorizationGate`, and for one release both
 * are live.
 *
 * This field decides whether a tool call is PERMITTED, so a half-applied
 * rename here is not a cosmetic problem. Four sites read it. Had each read
 * `params.verificationGate` directly, a host that set only the new name
 * would get a gate on one path and none on another — meaning a call
 * permitted somewhere it should have been refused, silently, in the
 * direction of more access.
 *
 * The assertion is therefore the DENIAL, not the shape of the config.
 * Asserting the gate was constructed would pass with the gate wired to
 * nothing.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const DENY_BASH = {
	enabled: true,
	rules: [{ type: 'deny_by_name', toolNames: ['bash'] }],
} as unknown as AuthorizationGateConfig

function registry(): ToolRegistry {
	const r = new ToolRegistry()
	r.register(
		defineTool({
			name: 'bash',
			description: 'runs a command',
			inputSchema: z.object({}),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: 'bash ran' }),
		}),
	)
	return r
}

async function run(fields: {
	verificationGate?: AuthorizationGateConfig
	authorizationGate?: AuthorizationGateConfig
}): Promise<string[]> {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-gate-spelling-'))
	dirs.push(workingDirectory)

	const result = await drainQuery({
		provider: new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 't1', name: 'bash', args: {} }], finishReason: 'tool_calls' },
				{ text: 'done' },
			],
		}),
		tools: registry(),
		runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 3 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('go')],
		workingDirectory,
		sessionId: 'ses_g' as SessionId,
		topicId: 'top_g' as TopicId,
		projectId: 'prj_g' as ProjectId,
		tenantId: 'tnt_g' as TenantId,
		...fields,
	})

	return result.messages
		.filter((m) => m.role === 'tool' && typeof m.content === 'string')
		.map((m) => m.content as string)
}

describe('either spelling of the gate field denies identically', () => {
	it('denies through the new name', async () => {
		const outputs = await run({ authorizationGate: DENY_BASH })

		expect(outputs[0]).not.toContain('bash ran')
	})

	it('denies through the deprecated name, for the whole window', async () => {
		// The pair is the point. One of these passing alone is exactly what a
		// partial migration looks like, and the type system cannot see it —
		// both fields have the same type, so a read of the wrong one compiles.
		const outputs = await run({ verificationGate: DENY_BASH })

		expect(outputs[0]).not.toContain('bash ran')
	})

	it('runs the tool when no gate is configured, so the denial is the gate speaking', async () => {
		// Without this the two above would pass against a runtime that denies
		// `bash` for some unrelated reason, and would keep passing with the
		// gate deleted entirely.
		const outputs = await run({})

		expect(outputs[0]).toContain('bash ran')
	})

	it('refuses two different configs, naming both fields', async () => {
		await expect(
			run({
				verificationGate: DENY_BASH,
				authorizationGate: { ...DENY_BASH, rules: [] } as unknown as AuthorizationGateConfig,
			}),
		).rejects.toThrow(/verificationGate[\s\S]*authorizationGate/)
	})
})
