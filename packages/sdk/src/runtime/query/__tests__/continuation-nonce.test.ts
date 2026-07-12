// Current-code invariants asserted (2026-07-12, ses_016 pre-freeze M5):
// - Continuation mode installs the frame-nonce DECLARATION. The caller owns the
//   whole history in that mode, so nothing else pushes a system message — and the
//   nonce is minted fresh per run. Without the declaration, every frame this run
//   emitted (`<task-notification-{nonce}>`, `<advisory-result-{nonce}>`) carried a
//   token the model had never been told to trust, which is worth exactly as much
//   as no token at all.
// - The declaration carries THIS run's nonce, not the stale one that may still sit
//   in the caller-supplied history from the previous run.
// - It is spliced in after the caller's own leading system run, so a cached static
//   system prefix keeps its position at the head of the conversation.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { ProjectId, SessionId, TenantId, ThreadId } from '../../../types/ids/index.js'
import {
	type Message,
	createSystemMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
} from '../../../types/provider/index.js'
import { drainQuery } from '../index.js'

const FRESH_NONCE = 'freshnonce0001'
const STALE_NONCE = 'stalenonce9999'

vi.mock('../../../utils/id.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../utils/id.js')>()
	return { ...actual, generateFrameNonce: () => FRESH_NONCE }
})

/** Captures the messages the provider is actually asked to complete. */
function makeCapturingProvider(): { provider: LLMProvider; seen: Message[][] } {
	const seen: Message[][] = []
	const provider: LLMProvider = {
		id: 'fake',
		name: 'Fake',
		async chat(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
			seen.push([...params.messages])
			return {
				id: 'r',
				model: 'm',
				message: { role: 'assistant', content: 'done' },
				finishReason: 'stop',
				usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
			} as ChatCompletionResponse
		},
		// biome-ignore lint/correctness/useYield: stub, never invoked
		async *chatStream() {
			throw new Error('not used')
		},
	}
	return { provider, seen }
}

async function run(messages: Message[], continuationMode: boolean): Promise<Message[]> {
	const { provider, seen } = makeCapturingProvider()
	await drainQuery({
		provider,
		tools: new ToolRegistry(),
		runConfig: { model: 'm', tokenBudget: 1_000_000, timeoutMs: 600_000, maxIterations: 5 },
		agentId: 'agent_test',
		agentName: 'Test',
		workingDirectory: mkdtempSync(join(tmpdir(), 'namzu-nonce-')),
		messages,
		continuationMode,
		sessionId: 'ses_test' as SessionId,
		threadId: 'thr_test' as ThreadId,
		projectId: 'prj_test' as ProjectId,
		tenantId: 'tnt_test' as TenantId,
	})
	return seen[0] ?? []
}

/** History as a continuation caller supplies it: last run's system prompt included. */
function continuedHistory(): Message[] {
	return [
		createSystemMessage(
			`You are an agent.\n\n<frame-authentication>\n${STALE_NONCE}\n</frame-authentication>`,
		),
		createUserMessage('the original request'),
	]
}

describe('continuation mode — frame nonce declaration', () => {
	it('declares this run’s nonce even though the caller owns the system prompt', async () => {
		const outbound = await run(continuedHistory(), true)

		const declaration = outbound.find(
			(m) =>
				m.role === 'system' &&
				(m.content ?? '').includes('<frame-authentication>') &&
				(m.content ?? '').includes(FRESH_NONCE),
		)
		expect(declaration).toBeDefined()
		expect(declaration?.content).toContain(`<task-notification-${FRESH_NONCE}>`)
	})

	it('keeps the caller’s cached system prefix at the head', async () => {
		const outbound = await run(continuedHistory(), true)

		expect(outbound[0]?.content).toContain('You are an agent.')
		// Spliced into the leading system run, not appended after the conversation.
		expect(outbound[1]?.role).toBe('system')
		expect(outbound[1]?.content).toContain(FRESH_NONCE)
	})

	it('preserves the caller’s messages verbatim otherwise', async () => {
		const outbound = await run(continuedHistory(), true)

		expect(outbound.some((m) => m.content === 'the original request')).toBe(true)
		// The stale declaration is left where it was: rewriting the caller's history
		// is not this mode's job, and the positive-only wording tolerates it.
		expect(outbound.some((m) => (m.content ?? '').includes(STALE_NONCE))).toBe(true)
	})

	it('non-continuation mode still declares the nonce through the normal prompt path', async () => {
		const outbound = await run([createUserMessage('hello')], false)

		expect(outbound.some((m) => (m.content ?? '').includes(FRESH_NONCE))).toBe(true)
	})
})
