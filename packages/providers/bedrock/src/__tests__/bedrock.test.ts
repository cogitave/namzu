import { DuplicateProviderError, ProviderRegistry } from '@namzu/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
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
				supportsVision: false,
				supportsDocuments: false,
				supportsToolResultImages: false,
				supportsToolResultDocuments: false,
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
