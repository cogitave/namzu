import type { AgentPersona } from '../types/persona/index.js'
import type { Skill } from '../types/skills/index.js'

export function assembleSystemPrompt(persona: AgentPersona, skills?: Skill[]): string {
	const sections: string[] = []

	sections.push(
		`## Identity\n**${persona.identity.role}**\n\n${persona.identity.description.trim()}`,
	)

	if (persona.expertise && persona.expertise.domains.length > 0) {
		const list = persona.expertise.domains.map((d) => `- ${d}`).join('\n')
		sections.push(`## Expertise\n${list}`)
	}

	if (persona.reflexes) {
		if (persona.reflexes.constraints.length > 0) {
			const list = persona.reflexes.constraints.map((c) => `- ${c.trim()}`).join('\n')
			sections.push(`## Constraints\n${list}`)
		}
		if (persona.reflexes.toolGuidance) {
			sections.push(`## Tool Guidance\n${persona.reflexes.toolGuidance.trim()}`)
		}
	}

	if (skills && skills.length > 0) {
		const loadedSkills = skills.filter((s) => s.body)
		if (loadedSkills.length > 0) {
			const skillSections = loadedSkills.map(
				(s) => `### ${s.metadata.name}\n**Skill directory:** \`${s.dirPath}\`\n\n${s.body}`,
			)
			sections.push(`## Skills\n\n${skillSections.join('\n\n')}`)
		}
	}

	if (persona.output) {
		sections.push(`## Output Format\n${persona.output.format.trim()}`)
	}

	if (persona.sessionContext) {
		sections.push(`## Session Context\n${persona.sessionContext.trim()}`)
	}

	return sections.join('\n\n')
}

export function mergePersonas(base: AgentPersona, override: Partial<AgentPersona>): AgentPersona {
	return {
		identity: override.identity ?? base.identity,
		expertise: {
			domains: [...(base.expertise?.domains ?? []), ...(override.expertise?.domains ?? [])],
		},
		reflexes: {
			constraints: [
				...(base.reflexes?.constraints ?? []),
				...(override.reflexes?.constraints ?? []),
			],
			toolGuidance: override.reflexes?.toolGuidance ?? base.reflexes?.toolGuidance,
		},
		output: override.output ?? base.output,
		sessionContext: override.sessionContext ?? base.sessionContext,
	}
}

export function withSessionContext(persona: AgentPersona, sessionContext: string): AgentPersona {
	return { ...persona, sessionContext }
}
