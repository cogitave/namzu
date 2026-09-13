import { z } from 'zod'
import { StreamTextAccumulator } from '../../provider/stream-text.js'
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
export function createCallbackInference(
	ctx: IterationContext,
	model: string,
	phase: 'preparation' | 'review',
) {
	const label = phase === 'preparation' ? 'Preparation' : 'Review'
	const owner = phase === 'preparation' ? 'preparation stage' : 'answer reviewer'
	const lifetime = new AbortController()
	let used = false
	return {
		close: () => lifetime.abort(new Error(`The ${owner} has ended.`)),
		async generateText(request: PreparationTextRequest): Promise<PreparationTextResult> {
			lifetime.signal.throwIfAborted()
			ctx.abortController.signal.throwIfAborted()
			request.signal?.throwIfAborted()
			const { signal: requestedSignal, ...fields } = request
			const input = requestSchema.parse(fields)
			if (input.system.length + input.prompt.length > 12_000)
				throw new Error(`${label} inference input exceeds 12,000 characters.`)
			if (used)
				throw new Error(
					`${phase === 'preparation' ? 'A' : 'An'} ${owner} may make only one inference call.`,
				)
			used = true
			const deadline = new AbortController()
			const timer = setTimeout(
				() => deadline.abort(new Error(`${label} inference timed out.`)),
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
			const text = new StreamTextAccumulator()
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
					if (chunk.delta.toolCalls?.length) invalidOutput = `${label} inference cannot call tools.`
					if (!invalidOutput) {
						text.push(chunk)
						if (text.characters > 8192)
							invalidOutput = `${label} inference output exceeds 8,192 characters.`
					}
				}
				signal.throwIfAborted()
				if (!usage) throw new Error(`${label} inference ended without usage.`)
				if (invalidOutput) throw new Error(invalidOutput)
				return { text: text.text, usage, servedBy: route() }
			} finally {
				clearTimeout(timer)
				if (usage) ctx.runMgr.accumulateUsage(usage, route())
			}
		},
	}
}
