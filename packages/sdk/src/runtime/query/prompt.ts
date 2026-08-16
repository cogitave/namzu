import { FILESYSTEM_TOOLS } from '../../constants/tools/index.js'
import { assembleSystemPrompt, renderSkillsSection } from '../../persona/assembler.js'
import {
	type PromptContributionContext,
	type PromptContributionRegistry,
	SKILLS_CONTRIBUTION_ID,
} from '../../prompt/contributions.js'
import type { AgentRuntimeContext } from '../../types/agent/base.js'
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
	runtimeContext?: AgentRuntimeContext
	/**
	 * What else goes in the prompt, beyond what this builder knows about.
	 *
	 * Absent means exactly what it meant before this existed: the fixed
	 * list. A capability that needs the model to know something registers
	 * here instead of arguing for a branch or splicing into `systemPrompt`
	 * and losing whatever was there.
	 */
	contributions?: PromptContributionRegistry
}

function buildEnvContext(workingDirectory: string, runtimeContext?: AgentRuntimeContext): string {
	const lines = [
		`<env>
Working directory: ${workingDirectory}
Platform: ${process.platform}`,
	]

	if (runtimeContext?.label) {
		lines.push(`Runtime: ${runtimeContext.label}`)
	}

	if (runtimeContext?.outputDirectory) {
		lines.push(`Output directory: ${runtimeContext.outputDirectory}`)
	}

	if (runtimeContext?.outputFileMarker) {
		lines.push(`Output file marker: ${runtimeContext.outputFileMarker}`)
	}

	if (runtimeContext?.notes?.length) {
		lines.push('Runtime notes:')
		for (const note of runtimeContext.notes) {
			lines.push(`- ${note}`)
		}
	}

	lines.push(`</env>

IMPORTANT: Always use absolute paths based on the working directory above. Before reading a file, use the glob tool to discover actual file paths — never guess or hallucinate paths.`)

	return lines.join('\n')
}

/**
 * Does this run have a tool that needs to know where it is?
 *
 * Decided from what a tool DECLARES — `category: 'filesystem'` or a
 * `file_read` / `file_write` permission — not from its name.
 *
 * The name set alone was a real hole: a host registering a perfectly
 * well-formed filesystem tool called `read_file` got no `<env>` block at
 * all, so the model was never told the working directory and the host had
 * to hand-encode the paths into its system prompt. The structured facts
 * were right there on the `ToolDefinition` and the gate ignored them in
 * favour of the four built-in names.
 *
 * The name set is kept as a fallback for tools that declare neither.
 */
function hasFilesystemTools(tools: ToolRegistryContract, allowedTools?: string[]): boolean {
	const activeTools = allowedTools ?? tools.listNames()
	return activeTools.some((name) => {
		if (FILESYSTEM_TOOLS.has(name)) return true
		const tool = tools.get?.(name)
		if (!tool) return false
		if (tool.category === 'filesystem' || tool.category === 'shell') return true
		return Boolean(
			tool.permissions?.some(
				(p) => p === 'file_read' || p === 'file_write' || p === 'shell_execute',
			),
		)
	})
}

export class PromptBuilder {
	private config: PromptBuilderConfig

	constructor(config: PromptBuilderConfig) {
		this.config = config
	}

	/**
	 * The context every contribution is rendered against.
	 *
	 * `workingDirectory` is a call argument rather than config, so it is
	 * threaded rather than read off `this`.
	 */
	private contributionContext(workingDirectory?: string): PromptContributionContext {
		return {
			...(workingDirectory === undefined ? {} : { workingDirectory }),
			...(this.config.runtimeContext ? { runtimeContext: this.config.runtimeContext } : {}),
			...(this.config.skills ? { skills: this.config.skills } : {}),
			...(this.config.allowedTools ? { allowedTools: this.config.allowedTools } : {}),
		}
	}

	/**
	 * Skills, once, in the slot they were always in.
	 *
	 * The registry renders at the END of the prompt, and skills belong where
	 * they have always been: immediately after the persona or system prompt.
	 * So the built-in contribution is rendered IN PLACE here rather than
	 * being left to the tail — a host that registers it gets the seam, not a
	 * reordered prompt.
	 *
	 * This is also what makes it a real contributor rather than a decorative
	 * one. Written first as "the builder renders skills, and the registry
	 * skips its own copy", which a mutation caught immediately: the
	 * contribution could be deleted with no observable effect, because the
	 * builder's own branch rendered skills either way. A seam whose first
	 * consumer is inert proves nothing about the seam.
	 *
	 * The persona branch is the exception and stays one:
	 * `assembleSystemPrompt(persona, skills)` places skills inside the
	 * persona's own section ordering, relative to constraints and output
	 * discipline. Routing it through here would silently reorder every
	 * persona-driven prompt in the estate.
	 */
	private renderSkillsInPlace(): string | null {
		const contribution = this.config.contributions
			?.list()
			.find((c) => c.id === SKILLS_CONTRIBUTION_ID)
		if (contribution) return contribution.render(this.contributionContext())
		return renderSkillsSection(this.config.skills)
	}

	/**
	 * `static` and `dynamic` only, and the signature says so.
	 *
	 * A `turn` contribution rendered here would land in the system prompt —
	 * cached for the run under `static`, or read as a standing instruction
	 * under `dynamic`. Either way the state it exists to report goes stale
	 * silently, which is the exact failure `turn` was added to avoid. The
	 * iteration loop renders those, into the ephemeral message.
	 */
	private renderContributions(
		placement: 'static' | 'dynamic',
		workingDirectory?: string,
	): readonly string[] {
		const registry = this.config.contributions
		if (!registry) return []
		const context = this.contributionContext(workingDirectory)
		return (
			registry
				.list()
				.filter((contribution) => contribution.placement === placement)
				// Skills is rendered IN PLACE by `renderSkillsInPlace`, so the tail
				// must not render it again. Unconditional, not branch-dependent:
				// under a persona it is already inside the persona section, and
				// otherwise it is already in its own slot above.
				.filter((contribution) => contribution.id !== SKILLS_CONTRIBUTION_ID)
				.map((contribution) => contribution.render(context))
				.filter((text): text is string => typeof text === 'string' && text.trim().length > 0)
		)
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
		} else {
			const skillSection = this.renderSkillsInPlace()
			if (skillSection) parts.push(skillSection)
		}

		if (this.config.systemPrompt) {
			const skillSection = this.renderSkillsInPlace()
			if (skillSection) parts.push(skillSection)
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

		if (contextLevel !== 'minimal' && workingDirectory) {
			const shouldIncludeEnv =
				hasFilesystemTools(this.config.tools, this.config.allowedTools) ||
				Boolean(this.config.runtimeContext)
			if (shouldIncludeEnv) {
				parts.push(buildEnvContext(workingDirectory, this.config.runtimeContext))
			}
		}

		// Static then dynamic, in that order and nothing between them,
		// because that is exactly how `buildSegmented` is rejoined upstream:
		// `${static}\n\n---\n\n${dynamic}`. The two methods produce the same
		// prompt for the same input, and a run that hits the prompt cache
		// must not be asking a different question from one that misses it.
		parts.push(...this.renderContributions('static', workingDirectory))
		parts.push(...this.renderContributions('dynamic', workingDirectory))

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
		} else {
			const skillSection = this.renderSkillsInPlace()
			if (skillSection) staticParts.push(skillSection)
		}

		if (this.config.systemPrompt) {
			const skillSection = this.renderSkillsInPlace()
			if (skillSection) staticParts.push(skillSection)
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

		if (contextLevel !== 'minimal' && workingDirectory) {
			const shouldIncludeEnv =
				hasFilesystemTools(this.config.tools, this.config.allowedTools) ||
				Boolean(this.config.runtimeContext)
			if (shouldIncludeEnv) {
				dynamicParts.push(buildEnvContext(workingDirectory, this.config.runtimeContext))
			}
		}

		staticParts.push(...this.renderContributions('static', workingDirectory))
		dynamicParts.push(...this.renderContributions('dynamic', workingDirectory))

		return {
			static: staticParts.join(separator),
			dynamic: dynamicParts.join(separator),
		}
	}
}
