import { z } from 'zod'
import { type TokenUsage, mergeTokenUsage } from '../../types/common/index.js'
import { createSystemMessage, createUserMessage } from '../../types/message/index.js'
import type { PreparationTextRequest, PreparationTextResult } from '../../types/run/prepare-step.js'
import type { IterationContext } from './iteration/phases/context.js'

const requestSchema = z
	.object({
		system: z.string().min(1).max(12_000),
		prompt: z.string().min(1).max(12_000),
		maxTokens: z.number().int().min(1).max(1024).default(256),
		timeoutMs: z.number().int().min(1).max(10_000).default(10_000),
	})
	.strict()

/** The provider already owns retry, fallback, cancellation and budget admission. */
export function createPreparationInference(ctx: IterationContext, model: string) {
	const lifetime = new AbortController()
	let used = false
	return {
		close: () => lifetime.abort(new Error('The preparation stage has ended.')),
		async generateText(request: PreparationTextRequest): Promise<PreparationTextResult> {
			lifetime.signal.throwIfAborted()
			ctx.abortController.signal.throwIfAborted()
			request.signal?.throwIfAborted()
			const { signal: requestedSignal, ...fields } = request
			const input = requestSchema.parse(fields)
			if (input.system.length + input.prompt.length > 12_000)
				throw new Error('Preparation inference input exceeds 12,000 characters.')
			if (used) throw new Error('A preparation stage may make only one inference call.')
			used = true
			const deadline = new AbortController()
			const timer = setTimeout(
				() => deadline.abort(new Error('Preparation inference timed out.')),
				input.timeoutMs,
			)
			const signal = AbortSignal.any([
				ctx.abortController.signal,
				lifetime.signal,
				deadline.signal,
				...(requestedSignal ? [requestedSignal] : []),
			])
			const requested = ctx.servingMember?.() ?? { index: 0, providerId: ctx.provider.id }
			const route = () => {
				const member = ctx.servingMember?.() ?? requested
				return {
					providerId: member.providerId,
					model: member.model ?? model,
					chainIndex: member.index,
				}
			}
			let text = ''
			let invalidOutput: string | undefined
			let usage: TokenUsage | undefined
			try {
				for await (const chunk of ctx.provider.chatStream({
					model,
					providerRoute: route(),
					messages: [createSystemMessage(input.system), createUserMessage(input.prompt)],
					maxTokens: input.maxTokens,
					...(ctx.runConfig.effort ? { effort: ctx.runConfig.effort } : {}),
					signal,
				})) {
					if (chunk.usage) usage = usage ? mergeTokenUsage(usage, chunk.usage) : { ...chunk.usage }
					if (chunk.error) throw new Error(chunk.error)
					signal.throwIfAborted()
					if (chunk.delta.toolCalls?.length)
						invalidOutput = 'Preparation inference cannot call tools.'
					if (!invalidOutput) {
						const next = chunk.delta.content ?? ''
						if (text.length + next.length > 8192)
							invalidOutput = 'Preparation inference output exceeds 8,192 characters.'
						else text += next
					}
				}
				signal.throwIfAborted()
				if (!usage) throw new Error('Preparation inference ended without usage.')
				if (invalidOutput) throw new Error(invalidOutput)
				return { text, usage, servedBy: route() }
			} finally {
				clearTimeout(timer)
				if (usage) ctx.runMgr.accumulateUsage(usage, route())
			}
		},
	}
}
