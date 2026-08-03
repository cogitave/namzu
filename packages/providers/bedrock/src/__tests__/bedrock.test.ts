import { DuplicateProviderError, ProviderRegistry } from '@namzu/sdk'
import { type ProviderError, classifyProviderError, isProviderError } from '@namzu/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { toBedrockMessages } from '../client.js'
import { BEDROCK_CAPABILITIES, BedrockProvider, registerBedrock } from '../index.js'

// Ensure a clean slate between tests. The sdk pre-registers 'mock' on import
// via its sideEffects whitelist; we only need to clear 'bedrock' to make
// re-registration deterministic across tests.
beforeEach(() => {
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
				supportsVision: true,
				// Images only: a document degrades to a named placeholder here.
				supportsDocuments: false,
			})
		})

		it('is exposed on the provider instance for runtime negotiation', () => {
			const provider = new BedrockProvider({ region: 'us-east-1' })
			expect(provider.capabilities).toEqual(BEDROCK_CAPABILITIES)
		})
	})

	it('keeps the Namzu enforcement hint out of the Bedrock command', async () => {
		const provider = new BedrockProvider({ region: 'us-east-1' })
		let commandInput: Record<string, unknown> | undefined
		;(provider as unknown as { client: unknown }).client = {
			send: async (command: { input: Record<string, unknown> }) => {
				commandInput = command.input
				return {
					$metadata: { requestId: 'request-test' },
					stream: (async function* () {})(),
				}
			},
		}

		for await (const _chunk of provider.chatStream({
			model: 'anthropic.claude-sonnet-5-v1:0',
			messages: [{ role: 'user', content: 'edit' }],
			tools: [
				{
					type: 'function',
					function: {
						name: 'edit',
						description: 'Edit',
						parameters: { type: 'object' },
					},
				},
			],
			enforceToolInputSchema: ['edit'],
		})) {
			// Drain the empty test stream.
		}

		expect(commandInput).not.toHaveProperty('enforceToolInputSchema')
		expect(commandInput?.toolConfig).toEqual({
			tools: [
				{
					toolSpec: {
						name: 'edit',
						description: 'Edit',
						inputSchema: { json: { type: 'object' } },
					},
				},
			],
			toolChoice: { auto: {} },
		})
	})
})

describe('Converse tool results carry failure status', () => {
	it('marks a failed tool result with status: error', () => {
		// The executor computed `isError`, the SSE and A2A bridges carried
		// it, and then this driver flattened every failure into an ordinary
		// success. Converse has a first-class field for it; the model's
		// trained tool-failure recovery path keys off that field.
		const mapped = toBedrockMessages([
			{ role: 'assistant', content: null, toolCalls: [] },
			{ role: 'tool', content: 'Error: file not found', toolCallId: 'call_1', isError: true },
		] as never)

		const block = mapped.flatMap((m) => m.content ?? []).find((c) => 'toolResult' in c)
		expect(block).toBeDefined()
		expect((block as { toolResult: { status?: string } }).toolResult.status).toBe('error')
	})

	it('leaves a successful tool result unmarked', () => {
		const mapped = toBedrockMessages([
			{ role: 'assistant', content: null, toolCalls: [] },
			{ role: 'tool', content: 'ok', toolCallId: 'call_1' },
		] as never)

		const block = mapped.flatMap((m) => m.content ?? []).find((c) => 'toolResult' in c)
		expect((block as { toolResult: { status?: string } }).toolResult.status).toBeUndefined()
	})
})

describe('service exceptions reach the runtime classified', () => {
	function throwing(name: string, status?: number) {
		const err = Object.assign(new Error(`${name} occurred`), { name })
		if (status !== undefined) Object.assign(err, { $metadata: { httpStatusCode: status } })
		return err
	}

	async function drive(err: Error) {
		const provider = new BedrockProvider({ region: 'us-east-1' })
		;(provider as never as { client: unknown }).client = {
			send: async () => {
				throw err
			},
		}
		try {
			for await (const _ of provider.chatStream({
				model: 'test-model',
				messages: [{ role: 'user', content: 'hi' }],
				maxTokens: 64,
			})) {
				// not reached
			}
		} catch (caught) {
			return caught
		}
		throw new Error('expected the stream to throw')
	}

	it('a throttle is retryable, so backoff actually happens', async () => {
		// Unclassified errors are treated as non-retryable, so before this
		// the retry policy was dead on this driver and the one failure most
		// worth backing off from was the one that killed the run.
		const caught = await drive(throwing('ThrottlingException', 429))
		expect(isProviderError(caught)).toBe(true)
		expect((caught as ProviderError).code).toBe('rate_limit')
		expect((caught as ProviderError).retryable).toBe(true)
		expect((caught as ProviderError).status).toBe(429)
	})

	it('an overloaded service is retryable', async () => {
		const caught = await drive(throwing('ServiceUnavailableException', 503))
		expect((caught as ProviderError).code).toBe('overloaded')
		expect((caught as ProviderError).retryable).toBe(true)
	})

	it('a rejected request is NOT retryable', async () => {
		// Resending an identical malformed request only wastes the budget.
		const caught = await drive(throwing('ValidationException', 400))
		expect((caught as ProviderError).code).toBe('invalid_request')
		expect((caught as ProviderError).retryable).toBe(false)
	})

	it('bad credentials are not retryable either', async () => {
		const caught = await drive(throwing('AccessDeniedException', 403))
		expect((caught as ProviderError).code).toBe('auth')
		expect((caught as ProviderError).retryable).toBe(false)
	})

	it('an unrecognised exception passes through untouched', async () => {
		// Better an honest unknown than a confident wrong classification.
		const caught = await drive(throwing('SomeFutureException'))
		expect(isProviderError(caught)).toBe(false)
	})

	it('the shared classifier can now read a metadata status on its own', () => {
		// Generic widening: a status is a status wherever a vendor hides it.
		const classified = classifyProviderError(throwing('Whatever', 429), 'bedrock')
		expect(classified.code).toBe('rate_limit')
		expect(classified.retryable).toBe(true)
	})
})

describe('ValidationException is left to the classifier', () => {
	const validation = (message: string) =>
		Object.assign(new Error(message), {
			name: 'ValidationException',
			$metadata: { httpStatusCode: 400 },
		})

	it('reaches the overflow rescue when the body says the input is too long', () => {
		// The driver used to pre-file this name as `invalid_request`, and the
		// shared classifier short-circuits on an error that already carries a
		// code — so the body was never read and the one rescue for this
		// failure could never fire.
		expect(classifyProviderError(validation('Input is too long for requested model.')).code).toBe(
			'context_length_exceeded',
		)
	})

	it('still classifies an ordinary validation failure as a bad request', () => {
		// Nothing is lost by not pre-filing: the status in the metadata bag
		// already maps to this.
		const classified = classifyProviderError(validation('The model id is not valid'))
		expect(classified.code).toBe('invalid_request')
		expect(classified.retryable).toBe(false)
	})
})
