import { randomUUID } from 'node:crypto'
import { attributionHeaders, providerHttpError } from '@namzu/sdk'
import type {
	ChatCompletionParams,
	LLMProvider,
	ModelInfo,
	ProviderCapabilities,
	StreamChunk,
	ToolCall,
} from '@namzu/sdk'
import type { GoogleConfig } from './types.js'
import {
	type Part,
	buildRequest,
	effortLevels,
	partDigest,
	routeFor,
	supportsGoogleSearch,
} from './wire.js'
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash'
// Standard text/image API reference prices, USD per million; not subscription billing.
const PRICES: Record<string, readonly [number, number]> = {
	'gemini-2.5-flash': [0.3, 2.5],
	'gemini-2.5-pro': [1.25, 10],
}
export const GOOGLE_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: true,
	supportsDocuments: true,
	supportsToolResultImages: true,
	supportsToolResultDocuments: true,
	supportsNativeStructuredOutput: true,
	supportsHostedWebSearch: true,
}
const API = 'https://generativelanguage.googleapis.com/v1beta'
const ASSIST = 'https://cloudcode-pa.googleapis.com/v1internal'
interface ResponseBody {
	response?: ResponseBody
	candidates?: Array<{
		content?: { parts?: Part[] }
		finishReason?: string
		groundingMetadata?: {
			webSearchQueries?: string[]
			groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>
		}
	}>
	promptFeedback?: { blockReason?: string }
	usageMetadata?: {
		promptTokenCount?: number
		candidatesTokenCount?: number
		thoughtsTokenCount?: number
		totalTokenCount?: number
		cachedContentTokenCount?: number
	}
}
/** Native GenerateContent transport; credential ownership remains with the host. */
export class GoogleProvider implements LLMProvider {
	readonly id = 'google'
	readonly name = 'Google Gemini'
	readonly capabilities = GOOGLE_CAPABILITIES
	private readonly fetcher: typeof globalThis.fetch
	private readonly projectId?: string
	constructor(private readonly config: GoogleConfig) {
		if (Boolean(config.apiKey) === Boolean(config.getAccessToken))
			throw new Error('Configure exactly one of Gemini apiKey or getAccessToken.')
		if (
			config.timeoutMs !== undefined &&
			(!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)
		)
			throw new Error('Gemini timeoutMs must be positive.')
		this.fetcher = config.fetch ?? globalThis.fetch
		this.projectId = config.projectId
	}
	supportsHostedWebSearchFor(model: string, mode: 'live' | 'cached') {
		return !this.config.getAccessToken && mode === 'live' && supportsGoogleSearch(model)
	}
	reasoningEffortLevelsFor(model: string) {
		return effortLevels(model)
	}
	private signal(signal?: AbortSignal) {
		const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 120_000)
		return signal ? AbortSignal.any([signal, timeout]) : timeout
	}
	private async request(
		url: string,
		signal: AbortSignal,
		body?: unknown,
		accessToken?: string,
	): Promise<Response> {
		signal.throwIfAborted()
		const headers: Record<string, string> = {
			...attributionHeaders(),
			'Content-Type': 'application/json',
		}
		if (this.config.getAccessToken)
			headers.Authorization = `Bearer ${accessToken ?? (await this.config.getAccessToken(signal))}`
		else headers['x-goog-api-key'] = this.config.apiKey as string
		signal.throwIfAborted()
		const res = await this.fetcher(url, {
			redirect: 'error',
			method: body === undefined ? 'GET' : 'POST',
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal,
		})
		if (!res.ok) {
			await res.body?.cancel()
			throw providerHttpError({
				providerId: this.id,
				status: res.status,
				retryAfter: res.headers.get('retry-after'),
			})
		}
		return res
	}
	private async project(
		signal: AbortSignal,
		verify = false,
		accessToken?: string,
	): Promise<string> {
		if (this.projectId && !verify) return this.projectId
		const res = await this.request(
			`${ASSIST}:loadCodeAssist`,
			signal,
			{
				cloudaicompanionProject: this.projectId,
				metadata: {
					ideType: 'IDE_UNSPECIFIED',
					platform: 'PLATFORM_UNSPECIFIED',
					pluginType: 'GEMINI',
				},
			},
			accessToken,
		)
		const data = (await res.json()) as {
			currentTier?: unknown
			cloudaicompanionProject?: string | { id?: string }
		}
		const project =
			typeof data.cloudaicompanionProject === 'string'
				? data.cloudaicompanionProject
				: (data.cloudaicompanionProject?.id ?? this.projectId)
		if (!data.currentTier || !project)
			throw new Error(
				'Complete Gemini CLI login and Code Assist setup before using this account in Namzu; automatic onboarding is not performed.',
			)
		return project
	}
	async probeCredential(signal?: AbortSignal): Promise<void> {
		const bounded = this.signal(signal)
		if (this.config.getAccessToken) await this.project(bounded, true)
		else await this.request(`${API}/models?pageSize=1`, bounded).then((r) => r.body?.cancel())
	}
	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		signal?.throwIfAborted()
		if (this.config.getAccessToken)
			return Object.keys(PRICES).map((id) => ({
				id,
				name: id,
				inputPrice: PRICES[id]?.[0] ?? 0,
				outputPrice: PRICES[id]?.[1] ?? 0,
				supportsToolUse: true,
				supportsStreaming: true,
				reasoningEffortLevels: effortLevels(id),
			}))
		const models: ModelInfo[] = []
		let pageToken: string | undefined
		const bounded = this.signal(signal)
		do {
			const res = await this.request(
				`${API}/models?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
				bounded,
			)
			const data = (await res.json()) as {
				models?: Array<{
					name: string
					displayName?: string
					inputTokenLimit?: number
					outputTokenLimit?: number
					supportedGenerationMethods?: string[]
				}>
				nextPageToken?: string
			}
			for (const m of data.models ?? [])
				if (m.supportedGenerationMethods?.includes('generateContent')) {
					const id = m.name.replace(/^models\//, '')
					models.push({
						id,
						name: m.displayName ?? id,
						contextWindow: m.inputTokenLimit,
						maxOutputTokens: m.outputTokenLimit,
						inputPrice: PRICES[id]?.[0] ?? 0,
						outputPrice: PRICES[id]?.[1] ?? 0,
						supportsToolUse: true,
						supportsStreaming: true,
						reasoningEffortLevels: effortLevels(id),
					})
				}
			pageToken = data.nextPageToken
		} while (pageToken)
		return models
	}
	async *chatStream(p: ChatCompletionParams): AsyncIterable<StreamChunk> {
		const scope = this.config.getAccessToken ? 'code-assist' : 'api-key'
		const body = buildRequest(p, scope)
		const signal = this.signal(p.signal)
		const id = randomUUID()
		const oauth = Boolean(this.config.getAccessToken)
		const accessToken = await this.config.getAccessToken?.(signal)
		const url = oauth
			? `${ASSIST}:streamGenerateContent?alt=sse`
			: `${API}/models/${encodeURIComponent(p.model)}:streamGenerateContent?alt=sse`
		const payload = oauth
			? {
					model: p.model,
					project: await this.project(signal, false, accessToken),
					user_prompt_id: id,
					request: body,
				}
			: body
		const res = await this.request(url, signal, payload, accessToken)
		if (!res.body) throw new Error('Gemini returned an empty streaming body.')
		const reader = res.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ''
		let terminal = false
		let text = ''
		let searched = false
		const sources = new Map<string, string>()
		let toolIndex = 0
		let reasoningIndex = 0
		const parts: Part[] = []
		const calls: ToolCall[] = []
		let usage: StreamChunk['usage']
		let finish: StreamChunk['finishReason']
		const parse = (event: string): ResponseBody | undefined => {
			const data = event
				.split('\n')
				.filter((l) => l.startsWith('data:'))
				.map((l) => l.slice(5).trimStart())
				.join('\n')
			return data && data !== '[DONE]' ? JSON.parse(data) : undefined
		}
		try {
			while (true) {
				signal.throwIfAborted()
				const next = await reader.read()
				buffer += decoder.decode(next.value, { stream: !next.done })
				buffer = buffer.replace(/\r\n/g, '\n')
				if (buffer.length > 16 * 1024 * 1024) throw new Error('Gemini SSE event exceeds 16 MiB.')
				let boundary = buffer.indexOf('\n\n')
				while (boundary >= 0 || (next.done && buffer.trim())) {
					const event = boundary >= 0 ? buffer.slice(0, boundary) : buffer
					buffer = boundary >= 0 ? buffer.slice(boundary + 2) : ''
					boundary = buffer.indexOf('\n\n')
					const envelope = parse(event)
					if (!envelope) continue
					const chunk = envelope.response ?? envelope
					if (chunk.promptFeedback?.blockReason) {
						terminal = true
						finish = 'content_filter'
					}
					const candidate = chunk.candidates?.[0]
					const grounding = candidate?.groundingMetadata
					if (
						grounding &&
						(grounding.webSearchQueries?.length || grounding.groundingChunks?.length)
					) {
						if (!searched)
							yield {
								id,
								delta: {
									hostedTool: {
										id: `${id}-search`,
										name: 'web_search',
										status: 'running',
									},
								},
							}
						searched = true
						for (const source of grounding.groundingChunks ?? []) {
							const url = source.web?.uri
							if (url && /^https?:\/\//.test(url)) sources.set(url, source.web?.title ?? url)
						}
					}
					for (const part of candidate?.content?.parts ?? []) {
						parts.push(part)
						if (part.functionCall) {
							const f = part.functionCall
							const callId = f.id ?? randomUUID()
							const args = JSON.stringify(f.args ?? {})
							calls.push({
								id: callId,
								type: 'function',
								function: { name: f.name, arguments: args },
							})
							yield {
								id,
								delta: {
									toolCalls: [
										{
											index: toolIndex,
											id: callId,
											type: 'function',
											function: { name: f.name, arguments: args },
										},
									],
								},
							}
							yield {
								id,
								delta: { toolCallEnd: { index: toolIndex++, id: callId } },
							}
						} else if (part.thought) {
							yield {
								id,
								delta: {
									reasoning: {
										index: reasoningIndex++,
										type: 'thinking',
										text: part.text ?? '',
										signature: part.thoughtSignature,
										done: true,
									},
								},
							}
						} else if (part.text) {
							text += part.text
							yield { id, delta: { content: part.text } }
						}
					}
					if (candidate?.finishReason) {
						terminal = true
						if (candidate.finishReason === 'MAX_TOKENS') finish = 'length'
						else if (candidate.finishReason === 'STOP')
							finish = calls.length ? 'tool_calls' : 'stop'
						else if (
							[
								'SAFETY',
								'RECITATION',
								'BLOCKLIST',
								'PROHIBITED_CONTENT',
								'SPII',
								'IMAGE_SAFETY',
							].includes(candidate.finishReason)
						)
							finish = 'content_filter'
						else throw new Error(`Gemini generation stopped with ${candidate.finishReason}.`)
					}
					const u = chunk.usageMetadata
					if (u)
						usage = {
							cachedTokens: u.cachedContentTokenCount ?? 0,
							cacheWriteTokens: 0,
							reasoningTokens: u.thoughtsTokenCount,
							promptTokens: u.promptTokenCount ?? 0,
							completionTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
							totalTokens:
								u.totalTokenCount ??
								(u.promptTokenCount ?? 0) +
									(u.candidatesTokenCount ?? 0) +
									(u.thoughtsTokenCount ?? 0),
						}
				}
				if (next.done) break
			}
			if (!terminal) throw new Error('Gemini stream ended without a terminal finish reason.')
			if (searched)
				yield {
					id,
					delta: {
						hostedTool: {
							id: `${id}-search`,
							name: 'web_search',
							status: 'completed',
						},
					},
				}
			const missing = [...sources.keys()].filter((url) => !text.includes(url))
			if (missing.length) {
				const appendix = `\n\nSources:\n${missing.map((url) => `- ${url}`).join('\n')}`
				text += appendix
				parts.push({ text: appendix })
				yield { id, delta: { content: appendix } }
			}

			yield {
				id,
				delta: {},
				finishReason: finish,
				usage,
				replayState: {
					kind: 'namzu-google',
					version: 1,
					scope,
					digest: partDigest(parts),
					route: routeFor(p),
					parts,
					text,
					calls,
				},
			}
		} finally {
			await reader.cancel().catch(() => {})
			reader.releaseLock()
		}
	}
}
