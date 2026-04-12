import { FILESYSTEM_TOOLS } from '../../constants/tools/index.js'
import { assembleSystemPrompt } from '../../persona/assembler.js'
import type { AgentContextLevel } from '../../types/agent/factory.js'
import type { AgentPersona } from '../../types/persona/index.js'
import type { Skill } from '../../types/skills/index.js'
import type { ToolRegistryContract } from '../../types/tool/index.js'

export interface PromptSegments {
	/** Layers 1-6: basePrompt, persona identity/expertise/reflexes/skills/outputDiscipline. Stable within a run. */
	readonly static: string
	/** Layers 7-10: tools, tier guidance, env context, sessionContext. May change per run. */
	readonly dynamic: string
}

export interface PromptBuilderConfig {
	systemPrompt?: string

	persona?: AgentPersona

	skills?: Skill[]

	basePrompt?: string

	tools: ToolRegistryContract
	allowedTools?: string[]
}

function buildEnvContext(workingDirectory: string): string {
	return `<env>
Working directory: ${workingDirectory}
Platform: ${process.platform}
</env>

IMPORTANT: Always use absolute paths based on the working directory above. Before reading a file, use the glob tool to discover actual file paths — never guess or hallucinate paths.`
}

function hasFilesystemTools(tools: ToolRegistryContract, allowedTools?: string[]): boolean {
	const activeTools = allowedTools ?? tools.listNames()
	return activeTools.some((name) => FILESYSTEM_TOOLS.has(name))
}

export class PromptBuilder {
	private config: PromptBuilderConfig

	constructor(config: PromptBuilderConfig) {
		this.config = config
	}

	build(contextLevel: AgentContextLevel = 'full', workingDirectory?: string): string {
		const parts: string[] = []

		if (contextLevel === 'full' && this.config.basePrompt) {
			parts.push(this.config.basePrompt)
		}

		if (this.config.systemPrompt) {
			parts.push(this.config.systemPrompt)
		} else if (this.config.persona) {
			parts.push(assembleSystemPrompt(this.config.persona, this.config.skills))
		}

		if (contextLevel !== 'minimal') {
			const toolSection = this.config.tools.toPromptSection(this.config.allowedTools)
			if (toolSection) {
				parts.push(toolSection)
			}

			const tierGuidance = this.config.tools.toTierGuidance()
			if (tierGuidance) {
				parts.push(tierGuidance)
			}
		}

		if (
			contextLevel !== 'minimal' &&
			workingDirectory &&
			hasFilesystemTools(this.config.tools, this.config.allowedTools)
		) {
			parts.push(buildEnvContext(workingDirectory))
		}

		return parts.join('\n\n---\n\n')
	}

	buildSegmented(
		contextLevel: AgentContextLevel = 'full',
		workingDirectory?: string,
	): PromptSegments {
		const separator = '\n\n---\n\n'
		const staticParts: string[] = []
		const dynamicParts: string[] = []

		if (contextLevel === 'full' && this.config.basePrompt) {
			staticParts.push(this.config.basePrompt)
		}

		if (this.config.systemPrompt) {
			staticParts.push(this.config.systemPrompt)
		} else if (this.config.persona) {
			const personaWithoutSession: AgentPersona = {
				...this.config.persona,
				sessionContext: undefined,
			}
			staticParts.push(assembleSystemPrompt(personaWithoutSession, this.config.skills))

			if (this.config.persona.sessionContext) {
				dynamicParts.push(`## Session Context\n${this.config.persona.sessionContext.trim()}`)
			}
		}

		if (contextLevel !== 'minimal') {
			const toolSection = this.config.tools.toPromptSection(this.config.allowedTools)
			if (toolSection) {
				dynamicParts.push(toolSection)
			}

			const tierGuidance = this.config.tools.toTierGuidance()
			if (tierGuidance) {
				dynamicParts.push(tierGuidance)
			}
		}

		if (
			contextLevel !== 'minimal' &&
			workingDirectory &&
			hasFilesystemTools(this.config.tools, this.config.allowedTools)
		) {
			dynamicParts.push(buildEnvContext(workingDirectory))
		}

		return {
			static: staticParts.join(separator),
			dynamic: dynamicParts.join(separator),
		}
	}
}
