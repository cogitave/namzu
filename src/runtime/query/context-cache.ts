import { createHash } from 'node:crypto'
import type { ToolRegistry } from '../../registry/tool/execute.js'
import type { ThreadId } from '../../types/ids/index.js'
import type { AgentPersona } from '../../types/persona/index.js'
import type { Skill } from '../../types/skills/index.js'
import { PromptBuilder } from './prompt.js'

export interface ContextCacheConfig {
	agentId: string
	threadId: ThreadId
}

export interface PromptCacheInput {
	systemPrompt?: string
	persona?: AgentPersona
	skills?: Skill[]
	basePrompt?: string
	tools: ToolRegistry
	allowedTools?: string[]
}

export class ContextCache {
	readonly threadId: ThreadId
	readonly agentId: string

	private cachedPrompt: string | undefined
	private cachedConfigHash: string | undefined

	constructor(config: ContextCacheConfig) {
		this.threadId = config.threadId
		this.agentId = config.agentId
	}

	getSystemPrompt(input: PromptCacheInput): string {
		const hash = this.computeConfigHash(input)

		if (this.cachedPrompt && this.cachedConfigHash === hash) {
			return this.cachedPrompt
		}

		const builder = new PromptBuilder({
			systemPrompt: input.systemPrompt,
			persona: input.persona,
			skills: input.skills,
			basePrompt: input.basePrompt,
			tools: input.tools,
			allowedTools: input.allowedTools,
		})

		this.cachedPrompt = builder.build()
		this.cachedConfigHash = hash
		return this.cachedPrompt
	}

	get configHash(): string | undefined {
		return this.cachedConfigHash
	}

	needsRebuild(input: PromptCacheInput): boolean {
		if (!this.cachedConfigHash) return true
		return this.computeConfigHash(input) !== this.cachedConfigHash
	}

	invalidate(): void {
		this.cachedPrompt = undefined
		this.cachedConfigHash = undefined
	}

	private computeConfigHash(input: PromptCacheInput): string {
		const parts: string[] = [
			this.agentId,
			input.systemPrompt ?? '',
			input.persona?.identity?.role ?? '',
			input.persona?.identity?.description ?? '',
			input.basePrompt ?? '',
			...(input.skills?.map((s) => s.metadata.name) ?? []),
			...(input.allowedTools ?? []),
		]

		return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
	}
}
