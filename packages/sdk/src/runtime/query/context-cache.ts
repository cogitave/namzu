import { createHash } from 'node:crypto'
import type { AgentContextLevel } from '../../types/agent/factory.js'
import type { AgentPersona } from '../../types/persona/index.js'
import type { ProjectId } from '../../types/session/ids.js'
import type { Skill } from '../../types/skills/index.js'
import type { ToolRegistryContract } from '../../types/tool/index.js'
import { PromptBuilder, type PromptSegments } from './prompt.js'

export interface ContextCacheConfig {
	agentId: string
	projectId: ProjectId
}

export interface PromptCacheInput {
	systemPrompt?: string
	persona?: AgentPersona
	skills?: Skill[]
	basePrompt?: string
	tools: ToolRegistryContract
	allowedTools?: string[]
}

export class ContextCache {
	readonly projectId: ProjectId
	readonly agentId: string

	private cachedPrompt: string | undefined
	private cachedConfigHash: string | undefined
	private cachedStaticSegment: string | undefined
	private cachedStaticHash: string | undefined

	constructor(config: ContextCacheConfig) {
		this.projectId = config.projectId
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

	getSystemPromptSegmented(
		input: PromptCacheInput,
		contextLevel: AgentContextLevel = 'full',
		workingDirectory?: string,
	): PromptSegments {
		const staticHash = this.computeStaticHash(input)

		const builder = new PromptBuilder({
			systemPrompt: input.systemPrompt,
			persona: input.persona,
			skills: input.skills,
			basePrompt: input.basePrompt,
			tools: input.tools,
			allowedTools: input.allowedTools,
		})

		const segments = builder.buildSegmented(contextLevel, workingDirectory)

		if (this.cachedStaticHash === staticHash && this.cachedStaticSegment !== undefined) {
			return {
				static: this.cachedStaticSegment,
				dynamic: segments.dynamic,
			}
		}

		this.cachedStaticSegment = segments.static
		this.cachedStaticHash = staticHash

		return segments
	}

	invalidate(): void {
		this.cachedPrompt = undefined
		this.cachedConfigHash = undefined
		this.cachedStaticSegment = undefined
		this.cachedStaticHash = undefined
	}

	private computeStaticHash(input: PromptCacheInput): string {
		const parts: string[] = [
			this.agentId,
			input.systemPrompt ?? '',
			input.persona?.identity?.role ?? '',
			input.persona?.identity?.description ?? '',
			input.basePrompt ?? '',
			...(input.skills?.map((s) => s.metadata.name) ?? []),
		]

		return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)
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
