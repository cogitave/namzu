import {
	DuplicateProviderError,
	type Message,
	ProviderRegistry,
	ProviderRequestError,
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
} from '@namzu/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BEDROCK_CAPABILITIES, registerBedrock } from '../index.js'

// Mock the AWS SDK so `client.send` is a controllable spy. The command classes
// are replaced with thin shells that expose their `.input` so tests can inspect
// the serialized request (Converse messages / inferenceConfig).
const { sendMock, clientConfigRef } = vi.hoisted(() => ({
	sendMock: vi.fn(),
	clientConfigRef: { value: undefined as Record<string, unknown> | undefined },
}))

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
	BedrockRuntimeClient: class {
		send = sendMock
		constructor(config: Record<string, unknown>) {
			clientConfigRef.value = config
		}
	},
	ConverseCommand: class {
		constructor(public input: Record<string, unknown>) {}
	},
	ConverseStreamCommand: class {
		constructor(public input: Record<string, unknown>) {}
	},
}))

// Imported after the mock is declared so the provider binds to the fake SDK.
const { BedrockProvider } = await import('../client.js')

// Ensure a clean slate between tests. The sdk pre-registers 'mock' on import
// via its sideEffects whitelist; we only need to clear 'bedrock' to make
// re-registration deterministic across tests.
beforeEach(() => {
	sendMock.mockReset()
	clientConfigRef.value = undefined
	if (ProviderRegistry.isSupported('bedrock')) {
		ProviderRegistry.unregister('bedrock')
	}
})

describe('@namzu/bedrock', () => {
	describe('registerBedrock()', () => {
		it("adds 'bedrock' to the ProviderRegistry", () => {
			expect(ProviderRegistry.isSupported('bedrock')).toBe(false)
			registerBedrock()
			expect(ProviderRegistry.isSupported('bedrock')).toBe(true)
			expect(ProviderRegistry.listTypes()).toContain('bedrock')
		})

		it('throws DuplicateProviderError when called twice without options', () => {
			registerBedrock()
			expect(() => registerBedrock()).toThrowError(DuplicateProviderError)
		})

		it('allows re-registration when { replace: true } is passed', () => {
			registerBedrock()
			expect(() => registerBedrock({ replace: true })).not.toThrow()
			expect(ProviderRegistry.isSupported('bedrock')).toBe(true)
		})

		it('exposes capabilities through the registry after registration', () => {
			registerBedrock()
			const caps = ProviderRegistry.getCapabilities('bedrock')
			expect(caps).toEqual(BEDROCK_CAPABILITIES)
		})
	})

	describe('BEDROCK_CAPABILITIES', () => {
		it('declares the expected capability flags', () => {
			expect(BEDROCK_CAPABILITIES).toEqual({
				supportsTools: true,
				supportsStreaming: true,
				supportsFunctionCalling: true,
				supportsAbortSignal: true,
			})
		})
	})
})

// ---------------------------------------------------------------------------
// Error taxonomy + AbortSignal forwarding + retry bounding + serializer guard
// (ses_015 Phase B)
//
// Current-code invariants asserted (2026-07-12, ses_015 Phase B):
//  - The client is constructed with maxAttempts:1 so the AWS SDK's own retry
//    loop cannot multiply against namzu's retry cap.
//  - chat() forwards params.signal to client.send as { abortSignal }.
//  - client.send rejections map onto ProviderRequestError kinds: Throttling →
//    throttle; ServiceUnavailable/InternalServer → server; AccessDenied → auth;
//    ValidationException → bad_request, unless the message reads "too long" /
//    context wording → context_overflow; network error codes → network; a
//    caller abort or AbortError → aborted.
//
// Current-code invariants asserted (2026-07-12, ses_015 fix-batch):
//  - context_overflow keys STRICTLY on "input is too long" (Converse's prompt
//    overflow wording). A maxTokens (output-cap) ValidationException — "The
//    maximum tokens you requested exceeds the model limit..." — maps to
//    bad_request, NOT context_overflow, so a doomed config request fails fast
//    instead of triggering destructive reactive compaction.
//  - toBedrockMessages serializes assistant toolCalls (valid, '{}', and
//    malformed args guarded to {}) plus tool results (including a synthesized
//    '[SYSTEM] Tool result missing...' result) without throwing.
// ---------------------------------------------------------------------------

function okConverseResponse(): Record<string, unknown> {
	return {
		output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
		stopReason: 'end_turn',
		usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		$metadata: { requestId: 'req-1', httpStatusCode: 200 },
	}
}

function awsError(name: string, message: string, httpStatusCode?: number): Error {
	const err = new Error(message)
	err.name = name
	if (httpStatusCode !== undefined) {
		Object.assign(err, { $metadata: { httpStatusCode } })
	}
	return err
}

describe('@namzu/bedrock — client configuration', () => {
	it('caps the AWS SDK retry loop at maxAttempts:1', async () => {
		sendMock.mockResolvedValue(okConverseResponse())
		const provider = new BedrockProvider({ region: 'us-east-1' })
		await provider.chat({ model: 'anthropic.claude', messages: [createUserMessage('hi')] })
		expect(clientConfigRef.value?.maxAttempts).toBe(1)
	})
})

describe('@namzu/bedrock — AbortSignal forwarding', () => {
	it('forwards params.signal to client.send as abortSignal', async () => {
		sendMock.mockResolvedValue(okConverseResponse())
		const controller = new AbortController()
		const provider = new BedrockProvider({ region: 'us-east-1' })
		await provider.chat({
			model: 'anthropic.claude',
			messages: [createUserMessage('hi')],
			signal: controller.signal,
		})
		const secondArg = sendMock.mock.calls[0]?.[1] as { abortSignal?: AbortSignal }
		expect(secondArg.abortSignal).toBe(controller.signal)
	})
})

describe('@namzu/bedrock — error taxonomy', () => {
	async function chatExpectError(err: Error, signal?: AbortSignal): Promise<ProviderRequestError> {
		sendMock.mockRejectedValue(err)
		const provider = new BedrockProvider({ region: 'us-east-1' })
		try {
			await provider.chat({
				model: 'anthropic.claude',
				messages: [createUserMessage('hi')],
				...(signal ? { signal } : {}),
			})
		} catch (e) {
			return e as ProviderRequestError
		}
		throw new Error('expected chat() to throw')
	}

	it('ThrottlingException → kind "throttle"', async () => {
		const err = await chatExpectError(awsError('ThrottlingException', 'slow down', 429))
		expect(err).toBeInstanceOf(ProviderRequestError)
		expect(err.kind).toBe('throttle')
		expect(err.status).toBe(429)
		expect(err.providerId).toBe('bedrock')
	})

	it('ServiceUnavailableException → kind "server"', async () => {
		const err = await chatExpectError(awsError('ServiceUnavailableException', 'unavailable', 503))
		expect(err.kind).toBe('server')
		expect(err.status).toBe(503)
	})

	it('InternalServerException → kind "server"', async () => {
		const err = await chatExpectError(awsError('InternalServerException', 'boom', 500))
		expect(err.kind).toBe('server')
	})

	it('AccessDeniedException → kind "auth"', async () => {
		const err = await chatExpectError(awsError('AccessDeniedException', 'denied', 403))
		expect(err.kind).toBe('auth')
		expect(err.status).toBe(403)
	})

	it('ValidationException with context-overflow wording → kind "context_overflow"', async () => {
		const err = await chatExpectError(
			awsError('ValidationException', 'Input is too long for requested model.', 400),
		)
		expect(err.kind).toBe('context_overflow')
		expect(err.status).toBe(400)
	})

	it('ValidationException without overflow wording → kind "bad_request"', async () => {
		const err = await chatExpectError(
			awsError('ValidationException', 'malformed request field', 400),
		)
		expect(err.kind).toBe('bad_request')
	})

	it('ValidationException for an over-cap maxTokens maps to bad_request, not overflow', async () => {
		// Output-cap config error: mentions "exceeds" and "tokens" but is NOT
		// prompt overflow, so it must fail fast rather than compact history.
		const err = await chatExpectError(
			awsError(
				'ValidationException',
				'The maximum tokens you requested exceeds the model limit for claude-3-5-sonnet',
				400,
			),
		)
		expect(err.kind).toBe('bad_request')
		expect(err.status).toBe(400)
	})

	it('network error code → kind "network"', async () => {
		const netErr = new Error('connection reset')
		Object.assign(netErr, { code: 'ECONNRESET' })
		const err = await chatExpectError(netErr)
		expect(err.kind).toBe('network')
	})

	it('AbortError → kind "aborted"', async () => {
		const err = await chatExpectError(awsError('AbortError', 'aborted'))
		expect(err.kind).toBe('aborted')
	})

	it('caller signal already aborted → kind "aborted" (takes precedence)', async () => {
		const controller = new AbortController()
		controller.abort()
		const err = await chatExpectError(
			awsError('ThrottlingException', 'slow', 429),
			controller.signal,
		)
		expect(err.kind).toBe('aborted')
	})

	it('unrecognized error with no status → kind "unknown"', async () => {
		const err = await chatExpectError(awsError('SomethingWeird', 'no idea'))
		expect(err.kind).toBe('unknown')
	})
})

describe('@namzu/bedrock — serializer round-trip', () => {
	it('serializes assistant toolCalls (valid/{}/malformed) + tool results without throwing', async () => {
		sendMock.mockResolvedValue(okConverseResponse())
		const provider = new BedrockProvider({ region: 'us-east-1' })

		const messages: Message[] = [
			createUserMessage('do the thing'),
			createAssistantMessage('calling tools', [
				{ id: 't1', type: 'function', function: { name: 'search', arguments: '{"q":"cats"}' } },
				{ id: 't2', type: 'function', function: { name: 'noop', arguments: '{}' } },
				{ id: 't3', type: 'function', function: { name: 'broken', arguments: '{not valid json' } },
			]),
			createToolMessage('found cats', 't1'),
			createToolMessage('{}', 't2'),
			createToolMessage(
				'[SYSTEM] Tool result missing: run was interrupted before this tool completed.',
				't3',
			),
		]

		await expect(provider.chat({ model: 'anthropic.claude', messages })).resolves.toBeDefined()

		const command = sendMock.mock.calls[0]?.[0] as { input: { messages: unknown[] } }
		const serialized = command.input.messages as {
			role: string
			content: Record<string, { toolUseId?: string; input?: unknown; content?: unknown }>[]
		}[]

		// Assistant message carries three toolUse blocks; malformed args coerced to {}.
		const assistant = serialized.find((m) => m.role === 'assistant')
		expect(assistant).toBeDefined()
		const toolUses = assistant?.content.filter((b) => 'toolUse' in b) ?? []
		expect(toolUses).toHaveLength(3)
		const broken = toolUses.find((b) => b.toolUse?.toolUseId === 't3')
		expect(broken?.toolUse?.input).toEqual({})

		// Tool results are flushed into a following user message with toolResult blocks,
		// including the synthesized "[SYSTEM] Tool result missing..." placeholder.
		const toolResultBlocks = serialized
			.filter((m) => m.role === 'user')
			.flatMap((m) => m.content)
			.filter((b) => 'toolResult' in b)
		expect(toolResultBlocks).toHaveLength(3)
	})
})
