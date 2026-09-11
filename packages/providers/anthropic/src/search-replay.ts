import { createHash } from 'node:crypto'
import type { ChatCompletionParams, ProviderRoute } from '@namzu/sdk'

type Block = Record<string, unknown>
type Assistant = Extract<ChatCompletionParams['messages'][number], { role: 'assistant' }>
const digest = (blocks: Block[]) =>
	createHash('sha256').update(JSON.stringify(blocks)).digest('hex')

/** Complete server-search blocks must round-trip, including encrypted results and citations. */
export function searchReplay(blocks: Block[], route: ProviderRoute, text: string) {
	return {
		kind: 'namzu-anthropic-search',
		version: 1,
		blocks,
		route,
		text,
		digest: digest(blocks),
	}
}
export function restoreSearch(msg: Assistant, route: ProviderRoute): Block[] | undefined {
	const source = msg.source
	if (
		!source ||
		source.type !== 'model' ||
		source.providerId !== route.providerId ||
		source.model !== route.model ||
		source.chainIndex !== route.chainIndex
	)
		return
	const state = source.replayState as ReturnType<typeof searchReplay> | undefined
	if (
		!state ||
		state.kind !== 'namzu-anthropic-search' ||
		state.version !== 1 ||
		JSON.stringify(state.route) !== JSON.stringify(route) ||
		!Array.isArray(state.blocks) ||
		state.blocks.some((b) => !b || typeof b !== 'object') ||
		state.digest !== digest(state.blocks) ||
		state.text !== msg.content
	)
		return
	const calls = state.blocks.filter((b) => b.type === 'tool_use')
	if (calls.length !== (msg.toolCalls?.length ?? 0)) return
	try {
		if (
			calls.some((b, i) => {
				const call = msg.toolCalls?.[i]
				if (!call) return true
				return (
					b.id !== call.id ||
					b.name !== call.function.name ||
					JSON.stringify(b.input) !== JSON.stringify(JSON.parse(call.function.arguments))
				)
			})
		)
			return
	} catch {
		return
	}
	const thinking = state.blocks.filter(
		(b) => b.type === 'thinking' || b.type === 'redacted_thinking',
	)
	if (
		thinking.length !== (msg.reasoning?.length ?? 0) ||
		thinking.some((b, i) => {
			const r = msg.reasoning?.[i]
			if (!r) return true
			return (
				b.type !== r.type ||
				(b.type === 'thinking'
					? b.thinking !== r.text || b.signature !== r.signature
					: b.data !== r.encrypted)
			)
		})
	)
		return
	return structuredClone(state.blocks)
}

/** Accumulate native content separately from locally executable tool calls. */
export class SearchBlocks {
	private readonly blocks = new Map<number, Block>()
	private readonly json = new Map<number, string>()
	private readonly active = new Set<number>()
	readonly sources = new Set<string>()
	hasSearch = false
	start(index: number, block: Block) {
		this.blocks.set(index, structuredClone(block))
		this.active.add(index)
		if (block.type === 'server_tool_use' || block.type === 'web_search_tool_result')
			this.hasSearch = true
		for (const citation of Array.isArray(block.citations) ? block.citations : [])
			this.cite(citation)
	}
	private cite(value: unknown) {
		const c = value as { url?: unknown } | undefined
		if (typeof c?.url === 'string' && /^https?:\/\//.test(c.url)) this.sources.add(c.url)
	}
	delta(
		index: number,
		delta: {
			type?: string
			text?: string
			thinking?: string
			signature?: string
			partial_json?: string
			citation?: unknown
		},
	) {
		const b = this.blocks.get(index)
		if (!b) return
		if (delta.type === 'text_delta') b.text = String(b.text ?? '') + (delta.text ?? '')
		if (delta.type === 'thinking_delta')
			b.thinking = String(b.thinking ?? '') + (delta.thinking ?? '')
		if (delta.type === 'signature_delta')
			b.signature = String(b.signature ?? '') + (delta.signature ?? '')
		if (delta.type === 'input_json_delta')
			this.json.set(index, (this.json.get(index) ?? '') + (delta.partial_json ?? ''))
		if (delta.type === 'citations_delta' && delta.citation) {
			b.citations = [...(Array.isArray(b.citations) ? b.citations : []), delta.citation]
			this.cite(delta.citation)
		}
	}
	stop(index: number) {
		const b = this.blocks.get(index)
		if (b && this.json.has(index)) b.input = JSON.parse(this.json.get(index) ?? '{}')
		this.active.delete(index)
	}
	complete(route: ProviderRoute) {
		if (!this.hasSearch) return
		if (this.active.size)
			throw new Error('Anthropic search stream ended with incomplete content blocks.')
		const blocks = [...this.blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b)
		const text = blocks
			.filter((b) => b.type === 'text')
			.map((b) => String(b.text ?? ''))
			.join('')
		const missing = [...this.sources].filter((url) => !text.includes(url))
		const appendix = missing.length
			? `\n\nSources:\n${missing.map((url) => `- ${url}`).join('\n')}`
			: ''
		return { appendix, replay: searchReplay(blocks, route, text + appendix) }
	}
}
