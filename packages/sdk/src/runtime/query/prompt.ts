import { assembleSystemPrompt } from '../../persona/assembler.js'
import type { ToolRegistry } from '../../registry/tool/execute.js'
import type { AgentContextLevel } from '../../types/agent/factory.js'
import type { AgentPersona } from '../../types/persona/index.js'
import type { Skill } from '../../types/skills/index.js'

const FILESYSTEM_TOOLS = new Set(['glob', 'read_file', 'write_file', 'bash'])

export interface PromptBuilderConfig {
	systemPrompt?: string

	persona?: AgentPersona

	skills?: Skill[]

	basePrompt?: string

	tools: ToolRegistry
	allowedTools?: string[]
}

function buildEnvContext(workingDirectory: string): string {
	return `<env>
Working directory: ${workingDirectory}
Platform: ${process.platform}
</env>

IMPORTANT: Always use absolute paths based on the working directory above. Before reading a file, use the glob tool to discover actual file paths — never guess or hallucinate paths.`
}

function hasFilesystemTools(tools: ToolRegistry, allowedTools?: string[]): boolean {
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
}
