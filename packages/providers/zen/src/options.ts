import { getModelCapabilities as getMessagesCapabilities } from '@ai-sdk/anthropic/internal'
import type { LanguageModelV3CallOptions, SharedV3ProviderOptions } from '@ai-sdk/provider'
import { type ChatCompletionParams, ProviderRequestError, type ProviderRoute } from '@namzu/sdk'
import { type ZenProtocol, type ZenService, findZenModel } from './models.js'
import { toModelPrompt } from './prompt.js'

export function createCallOptions(
	params: ChatCompletionParams,
	route: ProviderRoute,
	service: ZenService,
	protocol: ZenProtocol,
): LanguageModelV3CallOptions {
	const refuse = (detail: string): never => {
		throw new ProviderRequestError({ providerId: route.providerId, kind: 'bad_request', detail })
	}
	const known = findZenModel(service, params.model)
	let maxOutputTokens = params.maxTokens ?? 4096
	if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)
		refuse('maxTokens must be a positive integer.')
	if (
		params.effort !== undefined &&
		known?.effortLevels &&
		!known.effortLevels.includes(params.effort)
	)
		refuse('The selected model does not advertise this reasoning effort level.')
	if (params.repetitionPenalty !== undefined)
		refuse('repetitionPenalty is not supported by this driver.')
	if (params.topK !== undefined && protocol !== 'google' && protocol !== 'messages')
		refuse('topK is not supported by this model protocol.')
	if (
		protocol === 'messages' &&
		(params.frequencyPenalty !== undefined || params.presencePenalty !== undefined)
	)
		refuse('Frequency and presence penalties are not supported by the messages protocol.')
	if (params.cacheControl?.type === 'ephemeral' && protocol !== 'messages')
		refuse('Explicit ephemeral cache control requires the messages protocol.')
	const options: SharedV3ProviderOptions = {}
	switch (protocol) {
		case 'chat': {
			if (params.thinking?.budgetTokens !== undefined || params.thinking?.display !== undefined)
				refuse('This chat protocol cannot honor a thinking budget or display setting.')
			options.opencode = {
				...(params.effort !== undefined ? { reasoningEffort: params.effort } : {}),
				...(params.parallelToolCalls !== undefined
					? { parallel_tool_calls: params.parallelToolCalls }
					: {}),
				...(params.thinking ? { thinking: { type: params.thinking.type } } : {}),
				...(params.responseFormat?.type === 'json_schema'
					? { strictJsonSchema: params.responseFormat.json_schema.strict ?? true }
					: {}),
			}
			break
		}
		case 'responses': {
			if (params.stop !== undefined)
				refuse('Stop sequences are not supported by the responses protocol.')
			if (params.frequencyPenalty !== undefined || params.presencePenalty !== undefined)
				refuse('Frequency and presence penalties are not supported by the responses protocol.')
			if (params.thinking?.type === 'enabled' || params.thinking?.budgetTokens !== undefined)
				refuse('The responses protocol uses adaptive effort, not a fixed thinking budget.')
			if (
				params.thinking?.type === 'disabled' &&
				params.effort !== undefined &&
				params.effort !== 'none'
			)
				refuse('Disabled thinking conflicts with a non-none reasoning effort.')
			if (
				params.thinking?.type === 'disabled' &&
				known?.effortLevels &&
				!known.effortLevels.includes('none')
			)
				refuse('This model does not advertise disabled reasoning.')
			// The pinned native adapter removes sampling parameters from reasoning
			// requests. Its warning arrives after the POST, so reject that loss here.
			const gpt = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(params.model)
			const isReasoning =
				Boolean(known?.effortLevels?.length) ||
				/^o\d+(?:-|$)/.test(params.model) ||
				(gpt !== null &&
					Number(gpt[1]) >= 5 &&
					!(gpt[2] === undefined && gpt[3]?.startsWith('chat')))
			const effort = params.thinking?.type === 'disabled' ? 'none' : params.effort
			const allowsSampling =
				effort === 'none' && gpt !== null && Number(gpt[1]) === 5 && Number(gpt[2]) >= 1
			if (
				isReasoning &&
				!allowsSampling &&
				(params.temperature !== undefined || params.topP !== undefined)
			)
				refuse('Sampling parameters are not supported with this model’s reasoning configuration.')
			if (
				!isReasoning &&
				(params.effort !== undefined || params.thinking?.display === 'summarized')
			)
				refuse('This responses model does not support reasoning controls.')
			options.openai = {
				store: false,
				include: ['reasoning.encrypted_content'],
				...(known?.effortLevels?.length ? { forceReasoning: true } : {}),
				...(params.effort !== undefined ? { reasoningEffort: params.effort } : {}),
				...(params.thinking?.type === 'disabled' ? { reasoningEffort: 'none' } : {}),
				...(params.thinking?.display === 'summarized' ? { reasoningSummary: 'auto' } : {}),
				...(params.parallelToolCalls !== undefined
					? { parallelToolCalls: params.parallelToolCalls }
					: {}),
				...(params.responseFormat?.type === 'json_schema'
					? { strictJsonSchema: params.responseFormat.json_schema.strict ?? true }
					: {}),
			}
			break
		}
		case 'messages': {
			const thinking = params.thinking
			const capabilities = getMessagesCapabilities(params.model)
			const isThinking = thinking?.type === 'enabled' || thinking?.type === 'adaptive'
			if (
				(isThinking || capabilities.rejectsSamplingParameters) &&
				(params.temperature !== undefined || params.topP !== undefined || params.topK !== undefined)
			)
				refuse('Sampling parameters are not supported with this model’s thinking configuration.')
			if (
				params.temperature !== undefined &&
				(!Number.isFinite(params.temperature) || params.temperature < 0 || params.temperature > 1)
			)
				refuse('The messages protocol requires temperature between 0 and 1.')
			if (
				params.model.includes('claude-') &&
				params.temperature !== undefined &&
				params.topP !== undefined
			)
				refuse('This model cannot honor temperature and topP together.')
			if (
				params.responseFormat?.type === 'json_schema' &&
				params.responseFormat.json_schema.strict === false
			)
				refuse('The messages protocol cannot disable schema enforcement.')
			if (params.responseFormat?.type === 'json_object')
				refuse('The messages protocol requires a schema for JSON output.')
			if (
				capabilities.rejectsThinkingDisabledAboveHighEffort &&
				thinking?.type === 'disabled' &&
				(params.effort === 'xhigh' || params.effort === 'max')
			)
				refuse('This model cannot disable thinking at the requested effort level.')
			if (thinking?.budgetTokens !== undefined && thinking.type !== 'enabled')
				refuse('A thinking budget requires manual enabled thinking.')
			if (thinking?.display !== undefined && thinking.type !== 'adaptive')
				refuse('Thinking display selection requires adaptive thinking.')
			if (capabilities.isKnownModel && maxOutputTokens > capabilities.maxOutputTokens)
				refuse('maxTokens exceeds the selected model’s output limit.')
			if (thinking?.type === 'enabled') {
				// Namzu's cap includes thinking; the native adapter adds its budget
				// to maxOutputTokens, including a default 1024 when omitted.
				const budget = thinking.budgetTokens ?? 1024
				if (!Number.isSafeInteger(budget) || budget < 1024 || budget >= maxOutputTokens)
					refuse('Manual thinking requires a budget of at least 1024 below maxTokens.')
				maxOutputTokens -= budget
			}
			if (
				!capabilities.supportsStructuredOutput &&
				params.responseFormat?.type === 'json_schema' &&
				params.parallelToolCalls === true
			)
				refuse('This model cannot combine schema output with parallel tool calls.')
			if (
				!capabilities.supportsStructuredOutput &&
				params.tools?.some((tool) => params.enforceToolInputSchema?.includes(tool.function.name))
			)
				refuse('This model protocol cannot enforce strict tool input schemas.')
			options.anthropic = {
				...(params.responseFormat?.type === 'json_schema'
					? { structuredOutputMode: 'outputFormat' }
					: {}),
				sendReasoning: true,
				...(thinking ? { thinking: { ...thinking } } : {}),
				...(params.effort !== undefined ? { effort: params.effort } : {}),
				...(params.parallelToolCalls !== undefined
					? { disableParallelToolUse: !params.parallelToolCalls }
					: {}),
				...(params.cacheControl ? { cacheControl: { type: 'ephemeral' } } : {}),
			}
			break
		}
		case 'google': {
			if (params.parallelToolCalls !== undefined)
				refuse('The google protocol has no parallelToolCalls switch.')
			if (params.thinking?.budgetTokens !== undefined && params.thinking.type !== 'enabled')
				refuse('A thinking budget requires manual enabled thinking.')
			if (
				params.thinking?.type === 'disabled' &&
				params.effort !== undefined &&
				params.effort !== 'none'
			)
				refuse('Disabled thinking conflicts with a reasoning effort level.')
			options.google = {
				thinkingConfig: {
					includeThoughts: params.thinking?.display !== 'omitted',
					...(params.effort !== undefined ? { thinkingLevel: params.effort } : {}),
					...(params.thinking?.type === 'disabled' ? { thinkingBudget: 0 } : {}),
					...(params.thinking?.budgetTokens !== undefined
						? { thinkingBudget: params.thinking.budgetTokens }
						: {}),
				},
			}
			break
		}
	}
	const enforced = new Set(params.enforceToolInputSchema)
	return {
		prompt: toModelPrompt(params, route, service, protocol),
		maxOutputTokens,
		...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
		...(params.topP !== undefined ? { topP: params.topP } : {}),
		...(params.topK !== undefined ? { topK: params.topK } : {}),
		...(params.frequencyPenalty !== undefined ? { frequencyPenalty: params.frequencyPenalty } : {}),
		...(params.presencePenalty !== undefined ? { presencePenalty: params.presencePenalty } : {}),
		...(params.stop ? { stopSequences: params.stop } : {}),
		...(params.tools
			? {
					tools: params.tools.map((tool) => ({
						type: 'function' as const,
						name: tool.function.name,
						description: tool.function.description,
						inputSchema: tool.function.parameters,
						// Responses strict schemas cannot express Namzu's general
						// tool contract (including conditional edit shapes). Like
						// the Codex driver, retain the schema and validate inputs
						// at execution; enforcement is a capability-dependent hint.
						...(protocol === 'responses'
							? { strict: false }
							: enforced.has(tool.function.name)
								? { strict: true }
								: {}),
					})),
				}
			: {}),
		...(params.toolChoice
			? {
					toolChoice:
						typeof params.toolChoice === 'string'
							? { type: params.toolChoice }
							: { type: 'tool', toolName: params.toolChoice.function.name },
				}
			: {}),
		...(params.responseFormat
			? {
					responseFormat:
						params.responseFormat.type === 'json_object'
							? { type: 'json' as const }
							: {
									type: 'json' as const,
									schema: params.responseFormat.json_schema.schema,
									name: params.responseFormat.json_schema.name,
								},
				}
			: {}),
		providerOptions: options,
	}
}
