import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ChatCompletionParams, StreamChunk } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * A reply the output limit cuts off mid-text is continued: the loop asks the
 * model to go on from where it stopped. The Messages API's
 * `model_context_window_exceeded` became a `'length'` finish too, so that a
 * tool call it cuts off reads as cut off rather than malformed — and with
 * that, a reply that filled the model's whole context window was "continued"
 * as well, into a prompt one message longer than the window it had just
 * filled. `finishDetail: 'context_window'` is what tells the two apart.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const USAGE = {
	promptTokens: 10,
	completionTokens: 5,
	totalTokens: 15,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

/** A cut-off reply on the first request, and a closing one on any after it. */
class CutOffReply extends MockLLMProvider {
	constructor(private readonly finishDetail?: 'context_window') {
		super({ turns: [{ text: 'unused' }] })
	}

	override async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		this.requests.push(params)
		if (this.requests.length === 1) {
			yield { id: 'r1', delta: { content: 'The first half of a long answer' } }
			yield {
				id: 'r1',
				delta: {},
				finishReason: 'length',
				...(this.finishDetail ? { finishDetail: this.finishDetail } : {}),
				usage: USAGE,
			}
			return
		}
		yield { id: 'r2', delta: { content: ' and the rest.' } }
		yield { id: 'r2', delta: {}, finishReason: 'stop', usage: USAGE }
	}
}

async function turn(provider: MockLLMProvider) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-context-window-'))
	dirs.push(workingDirectory)
	return await drainQuery({
		provider,
		tools: new ToolRegistry(),
		turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 5 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('write it all')],
		workingDirectory,
		sessionId: '6f2d1c1e-7a0e-4a8e-9a57-2f1c0b8e4d31' as SessionId,
		topicId: 'a3c4d5e6-1b2c-4d3e-8f90-123456789abc' as TopicId,
		projectId: 'b4c5d6e7-2c3d-4e5f-9a01-23456789abcd' as ProjectId,
		tenantId: 'c5d6e7f8-3d4e-4f60-8b12-3456789abcde' as TenantId,
	})
}

describe('a reply that filled the context window', () => {
	it('is not continued: there is no room left to continue into', async () => {
		const provider = new CutOffReply('context_window')
		await turn(provider)
		expect(provider.requests).toHaveLength(1)
	})

	it('while a reply the output limit cut off still is', async () => {
		const provider = new CutOffReply()
		await turn(provider)
		expect(provider.requests).toHaveLength(2)
	})
})
