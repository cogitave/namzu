import { describe, expect, it } from 'vitest'

import { resolveProviderCapabilities } from '../../../provider/capabilities.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import type { MessageAttachment } from '../../../types/message/index.js'
import type { ChatCompletionParams, ProviderCapabilities } from '../../../types/provider/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * Documents existed in the type system only in the TOOL-RESULT direction,
 * so "here is the contract, answer questions about it" was reachable only
 * by having a tool read the file and stringify it. That loses the
 * provider's native document handling — page structure, built-in OCR,
 * citations — and pays the text cost instead.
 */

registerMock()

const PDF = {
	type: 'document' as const,
	data: 'JVBERi0xLjQK',
	mediaType: 'application/pdf',
	name: 'contract.pdf',
}
const PNG = { data: 'iVBORw0KGgo=', mediaType: 'image/png' }

const capabilities = (over: Partial<ProviderCapabilities>): ProviderCapabilities =>
	({
		supportsTools: true,
		supportsStreaming: true,
		supportsFunctionCalling: true,
		supportsVision: true,
		supportsDocuments: true,
		...over,
	}) as ProviderCapabilities

function runWith(opts: {
	attachments: readonly MessageAttachment[]
	capabilities?: ProviderCapabilities
	strict?: boolean
}) {
	const provider = new MockLLMProvider({
		turns: [{ text: 'read it' }],
		...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
	})

	const settled = drainQuery({
		provider,
		tools: new ToolRegistry(),
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user', content: 'answer from the file', attachments: opts.attachments }],
		workingDirectory: process.cwd(),
		runConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 30_000, maxIterations: 2 },
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		...(opts.strict ? { strictCapabilities: true } : {}),
	})

	return { settled, requests: provider.requests as ChatCompletionParams[] }
}

describe('a user message that carries a document', () => {
	it('reaches the driver alongside the text', async () => {
		const { settled, requests } = runWith({ attachments: [PDF] })
		await settled

		const sent = requests[0]?.messages.find((m) => m.role === 'user')
		expect((sent as { attachments?: unknown[] })?.attachments).toEqual([PDF])
	})

	it('refuses to run against a driver that says it cannot map documents', async () => {
		await expect(
			runWith({
				attachments: [PDF],
				capabilities: capabilities({ supportsDocuments: false }),
				strict: true,
			}).settled,
		).rejects.toThrow(/supportsDocuments: false/)
	})

	it('does not fire the document check for an image', async () => {
		// The two are separate wire shapes, and a check aimed at the wrong
		// one sends the reader to the wrong half of the driver.
		await expect(
			runWith({
				attachments: [PNG],
				capabilities: capabilities({ supportsDocuments: false }),
				strict: true,
			}).settled,
		).resolves.toBeDefined()
	})

	it('does not fire the vision check for a document', async () => {
		await expect(
			runWith({
				attachments: [PDF],
				capabilities: capabilities({ supportsVision: false }),
				strict: true,
			}).settled,
		).resolves.toBeDefined()
	})
})

describe('a driver that declares nothing', () => {
	it('is assumed to handle documents, like every other capability', () => {
		// A driver written before the field existed must not start warning.
		expect(resolveProviderCapabilities({ capabilities: undefined }).supportsDocuments).toBe(true)
	})

	it('keeps its own answer when it declares one', () => {
		expect(
			resolveProviderCapabilities({ capabilities: capabilities({ supportsDocuments: false }) })
				.supportsDocuments,
		).toBe(false)
	})
})
