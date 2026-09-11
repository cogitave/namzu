import { createHash } from 'node:crypto'
import type { PromptContributionRegistry } from '../../prompt/contributions.js'
import type { AgentRuntimeContext } from '../../types/agent/base.js'
import type { AgentContextLevel } from '../../types/agent/factory.js'
import type { AgentPersona } from '../../types/persona/index.js'
import type { ProjectId } from '../../types/session/ids.js'
import type { Skill } from '../../types/skills/index.js'
import type { ToolRegistryContract } from '../../types/tool/index.js'
import { PromptBuilder, type PromptSegments } from './prompt.js'

export interface PromptCacheConfig {
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
	runtimeContext?: AgentRuntimeContext
	contributions?: PromptContributionRegistry
}

export class PromptCache {
	readonly projectId: ProjectId
	readonly agentId: string

	private cachedPrompt: string | undefined
	private cachedConfigHash: string | undefined
	private cachedStaticSegment: string | undefined
	private cachedStaticHash: string | undefined

	constructor(config: PromptCacheConfig) {
		this.projectId = config.projectId
		this.agentId = config.agentId
	}

	getSystemPrompt(input: PromptCacheInput): string {
		const builder = new PromptBuilder({
			systemPrompt: input.systemPrompt,
			persona: input.persona,
			skills: input.skills,
			basePrompt: input.basePrompt,
			tools: input.tools,
			allowedTools: input.allowedTools,
			runtimeContext: input.runtimeContext,
			...(input.contributions ? { contributions: input.contributions } : {}),
		})

		const prompt = builder.build()
		const hash = this.computeConfigHash(input, prompt)

		if (this.cachedPrompt !== undefined && this.cachedConfigHash === hash) {
			return this.cachedPrompt
		}

		this.cachedPrompt = prompt
		this.cachedConfigHash = hash
		return this.cachedPrompt
	}

	get configHash(): string | undefined {
		return this.cachedConfigHash
	}

	needsRebuild(input: PromptCacheInput): boolean {
		if (!this.cachedConfigHash) return true
		return this.computeConfigHash(input, new PromptBuilder(input).build()) !== this.cachedConfigHash
	}

	getSystemPromptSegmented(
		input: PromptCacheInput,
		contextLevel: AgentContextLevel = 'full',
		workingDirectory?: string,
	): PromptSegments {
		const builder = new PromptBuilder({
			systemPrompt: input.systemPrompt,
			persona: input.persona,
			skills: input.skills,
			basePrompt: input.basePrompt,
			tools: input.tools,
			allowedTools: input.allowedTools,
			runtimeContext: input.runtimeContext,
			...(input.contributions ? { contributions: input.contributions } : {}),
		})

		const segments = builder.buildSegmented(contextLevel, workingDirectory)
		const staticHash = this.computeStaticHash(segments.static)

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

	private computeStaticHash(staticSegment: string): string {
		// Static means stable within a run, but a cache can outlive that run.
		// A fresh registry or a replacement can keep the same ids while its
		// instructions change. Hash the text already built for this request,
		// including persona, skills and context-level choices, without
		// rendering any contribution twice or including dynamic/turn text.
		return createHash('sha256').update(staticSegment).digest('hex').slice(0, 16)
	}

	private computeConfigHash(input: PromptCacheInput, prompt: string): string {
		const parts = [
			this.agentId,
			prompt,
			// Keep placement changes visible to needsRebuild even when the
			// unsegmented text happens to be identical.
			input.contributions?.list().map((c) => [c.id, c.placement]) ?? [],
		]

		return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
	}
}
