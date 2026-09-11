import { createHash } from 'node:crypto'
import type { ChatCompletionParams, ReasoningEffort } from '@namzu/sdk'
import { toToolResultBlocks } from '@namzu/sdk'
export interface Part {
	text?: string
	thought?: boolean
	thoughtSignature?: string
	functionCall?: { name: string; args?: Record<string, unknown>; id?: string }
	[key: string]: unknown
}
export interface Content {
	role: string
	parts: Part[]
}
export interface Replay {
	kind: 'namzu-google'
	version: 1
	scope: string
	digest: string
	route: unknown
	parts: Part[]
	text: string
	calls: unknown
}
export function effortLevels(model: string): readonly ReasoningEffort[] | undefined {
	if (model === 'gemini-3-flash-preview') return ['minimal', 'low', 'medium', 'high']
	if (model === 'gemini-3-pro-preview') return ['low', 'high']
	if (/^gemini-2\.5-/.test(model)) return []
	return undefined
}
export function routeFor(p: ChatCompletionParams) {
	return p.providerRoute ?? { providerId: 'google', model: p.model, chainIndex: 0 }
}
export function partDigest(parts: Part[]): string {
	return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}
/** Models whose GenerateContent wire supports grounding alongside function tools. */
export function supportsGoogleSearch(model: string): boolean {
	return [
		'gemini-3-flash-preview',
		'gemini-3-pro-preview',
		'gemini-3.1-pro-preview',
		'gemini-3.5-flash',
		'gemini-3.5-flash-lite',
		'gemini-3.6-flash',
		'gemini-3.7-flash',
		'gemini-3.8-flash',
	].includes(model)
}
export function buildRequest(p: ChatCompletionParams, scope = 'api-key'): Record<string, unknown> {
	for (const key of ['parallelToolCalls', 'repetitionPenalty'] as const)
		if (p[key] !== undefined) throw new Error(`Gemini does not support explicit ${key}.`)
	if (p.cacheControl?.type === 'ephemeral')
		throw new Error('Gemini does not support explicit ephemeral cache control.')
	// enforceToolInputSchema is an optional optimization hint. Native tool schemas
	// are sent below; unsupported strict generation is not claimed.
	const generationConfig: Record<string, unknown> = {}
	for (const [from, to] of [
		['maxTokens', 'maxOutputTokens'],
		['temperature', 'temperature'],
		['topP', 'topP'],
		['topK', 'topK'],
		['stop', 'stopSequences'],
		['frequencyPenalty', 'frequencyPenalty'],
		['presencePenalty', 'presencePenalty'],
	] as const)
		if (p[from] !== undefined) generationConfig[to] = p[from]
	if (p.responseFormat) {
		generationConfig.responseMimeType = 'application/json'
		if (p.responseFormat.type === 'json_schema')
			generationConfig.responseJsonSchema = p.responseFormat.json_schema.schema
	}
	if (p.effort || p.thinking) {
		const t: Record<string, unknown> = {}
		if (p.effort) {
			if (!effortLevels(p.model)?.includes(p.effort))
				throw new Error(`Gemini does not publish effort ${p.effort} for ${p.model}.`)
			t.thinkingLevel = p.effort.toUpperCase()
		}
		if (p.thinking) {
			const cfg = p.thinking
			if (cfg.type === 'disabled') {
				if (!/^gemini-2\.5-flash/.test(p.model))
					throw new Error(`Thinking cannot be disabled for ${p.model}.`)
				t.thinkingBudget = 0
			} else if (cfg.type === 'enabled') {
				if (
					!/^gemini-2\.5-/.test(p.model) ||
					!Number.isInteger(cfg.budgetTokens) ||
					(cfg.budgetTokens ?? 0) <= 0
				)
					throw new Error(
						'Manual Gemini thinking requires a Gemini 2.5 model and positive integer budgetTokens.',
					)
				t.thinkingBudget = cfg.budgetTokens
			} else if (/^gemini-2\.5-/.test(p.model)) t.thinkingBudget = -1
			else if (!effortLevels(p.model)?.length)
				throw new Error(`Unknown adaptive thinking support for ${p.model}.`)
			if (cfg.type !== 'enabled' && cfg.budgetTokens !== undefined)
				throw new Error('budgetTokens requires enabled thinking.')
			t.includeThoughts = cfg.display === 'summarized'
		}
		generationConfig.thinkingConfig = t
	}
	const contents: Content[] = []
	const system: Part[] = []
	const names = new Map<string, string>()
	const nativeIds = new Map<string, string | undefined>()
	for (const m of p.messages) {
		if (m.role === 'system') {
			system.push({ text: m.content })
			continue
		}
		let parts: Part[] = []
		if (m.role === 'assistant') {
			for (const call of m.toolCalls ?? []) names.set(call.id, call.function.name)
			const r = m.source?.replayState as Replay | undefined
			if (
				r?.kind === 'namzu-google' &&
				r.version === 1 &&
				r.scope === scope &&
				Array.isArray(r.parts) &&
				r.digest === partDigest(r.parts) &&
				JSON.stringify(r.route) === JSON.stringify(routeFor(p)) &&
				m.source?.providerId === routeFor(p).providerId &&
				m.source?.model === p.model &&
				m.source?.chainIndex === routeFor(p).chainIndex &&
				r.text === (m.content ?? '') &&
				JSON.stringify(r.calls) === JSON.stringify(m.toolCalls ?? []) &&
				Array.isArray(r.parts)
			)
				parts = r.parts
			else {
				if (m.content) parts.push({ text: m.content })
				for (const call of m.toolCalls ?? [])
					parts.push({
						functionCall: {
							name: call.function.name,
							args: JSON.parse(call.function.arguments),
							id: call.id,
						},
					})
			}
			const nativeCalls = parts.filter((part) => part.functionCall).map((part) => part.functionCall)
			for (const [index, call] of (m.toolCalls ?? []).entries())
				nativeIds.set(call.id, nativeCalls[index]?.id)
		} else if (m.role === 'tool') {
			const name = names.get(m.toolCallId)
			if (!name) throw new Error('Gemini tool result has no matching function call.')
			const blocks = toToolResultBlocks(m.content)
			parts.push({
				functionResponse: {
					name,
					...(nativeIds.get(m.toolCallId) !== undefined ? { id: nativeIds.get(m.toolCallId) } : {}),
					response: {
						[m.isError ? 'error' : 'output']: blocks
							.filter((b) => b.type === 'text')
							.map((b) => b.text)
							.join('\n'),
					},
				},
			})
			for (const b of blocks)
				if (b.type !== 'text') {
					if ('modelOmission' in b && b.modelOmission)
						parts.push({ text: '[Attachment omitted from model context]' })
					else parts.push({ inlineData: { mimeType: b.mediaType, data: b.data } })
				}
		} else {
			if (m.content) parts.push({ text: m.content })
			for (const a of m.attachments ?? []) {
				if (a.type === 'stored')
					throw new Error('Resolve stored attachments before calling Gemini.')
				if ('modelOmission' in a && a.modelOmission)
					parts.push({ text: '[Attachment omitted from model context]' })
				else {
					if (a.type === 'document' && a.citations)
						throw new Error('Gemini document citations are not supported by this driver.')
					parts.push({ inlineData: { mimeType: a.mediaType, data: a.data } })
				}
			}
		}
		if (parts.length) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts })
	}
	if (
		p.webSearch &&
		(p.responseFormat ||
			scope !== 'api-key' ||
			p.webSearch.mode !== 'live' ||
			!supportsGoogleSearch(p.model))
	)
		throw new Error(
			'Google native search requires a supported Gemini 3 API-key route and live mode.',
		)
	const req: Record<string, unknown> = { contents, generationConfig }
	if (system.length) req.systemInstruction = { parts: system }
	if (p.tools?.length)
		req.tools = [
			{
				functionDeclarations: p.tools.map((t) => ({
					name: t.function.name,
					description: t.function.description,
					parametersJsonSchema: t.function.parameters,
				})),
			},
		]
	if (p.webSearch) req.tools = [...((req.tools as unknown[]) ?? []), { googleSearch: {} }]
	if (p.toolChoice)
		req.toolConfig = {
			functionCallingConfig:
				typeof p.toolChoice === 'string'
					? {
							mode: { auto: 'AUTO', none: 'NONE', required: 'ANY' }[p.toolChoice],
						}
					: { mode: 'ANY', allowedFunctionNames: [p.toolChoice.function.name] },
		}
	return req
}
