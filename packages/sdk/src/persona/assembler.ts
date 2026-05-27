import type { AgentPersona, OutputDiscipline } from '../types/persona/index.js'
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

	const skillsSection = renderSkillsSection(skills)
	if (skillsSection) {
		sections.push(skillsSection)
	}

	if (persona.reflexes?.outputDiscipline) {
		sections.push(renderOutputDiscipline(persona.reflexes.outputDiscipline))
	}

	if (persona.output) {
		sections.push(`## Output Format\n${persona.output.format.trim()}`)
	}

	if (persona.sessionContext) {
		sections.push(`## Session Context\n${persona.sessionContext.trim()}`)
	}

	return sections.join('\n\n')
}

export function renderSkillsSection(skills?: Skill[]): string | null {
	if (!skills || skills.length === 0) return null

	const available = skills
		.map((s) => {
			const lines = [
				'<skill>',
				`<name>${s.metadata.name}</name>`,
				`<description>${s.metadata.description.trim()}</description>`,
				`<location>${s.dirPath}/SKILL.md</location>`,
			]
			if (s.metadata.compatibility) {
				lines.push(`<compatibility>${s.metadata.compatibility}</compatibility>`)
			}
			if (s.metadata.license) {
				lines.push(`<license>${s.metadata.license}</license>`)
			}
			if (s.metadata.allowedTools) {
				lines.push(`<allowed_tools>${s.metadata.allowedTools}</allowed_tools>`)
			}
			lines.push('</skill>')
			return lines.join('\n')
		})
		.join('\n')

	const loadedSkills = skills.filter((s) => s.body)
	const sections = [
		`## Available Skills\nThe following block is a manifest, not the full skill content. Skill metadata is always visible; SKILL.md bodies are loaded only when the user's task matches the skill description.\n\n<available_skills>\n${available}\n</available_skills>\n\nSkill usage protocol:\n- Plain questions do not require a skill.\n- When a matching skill is already listed under Loaded Skills, apply its loaded instructions.\n- When a matching skill is not loaded and the runtime exposes filesystem or skill-loading tools, read the SKILL.md at its <location> before writing code, creating files, running shell commands for that workflow, or calling mutation tools guided by the skill.\n- Do not claim to have read a SKILL.md until its content is actually present in the prompt or returned by a tool.\n- Tool schemas and runtime permissions remain authoritative; skills provide guidance, not hidden tools.`,
	]

	if (loadedSkills.length > 0) {
		const skillSections = loadedSkills.map(
			(s) => `### ${s.metadata.name}\n**Skill directory:** \`${s.dirPath}\`\n\n${s.body}`,
		)
		sections.push(`## Loaded Skills\n\n${skillSections.join('\n\n')}`)
	}

	return sections.join('\n\n')
}

export function renderOutputDiscipline(discipline: OutputDiscipline): string {
	const lines: string[] = []

	if (discipline.betweenToolCalls === 'silent') {
		lines.push('- Emit zero words between tool calls. Call tools back-to-back with no narration.')
	} else {
		lines.push(
			'- Emit minimal text between tool calls. Keep inter-tool narration to a single short sentence.',
		)
	}

	if (discipline.suppressInnerMonologue) {
		lines.push('- Do not output inner monologue, reasoning traces, or planning text between turns.')
	}

	if (discipline.finalResponse?.singleFileMaxWords) {
		lines.push(
			`- Final response for single-file changes: ${discipline.finalResponse.singleFileMaxWords} words maximum. Describe the why, not the what.`,
		)
	}

	if (discipline.finalResponse?.multiFileMaxWords) {
		lines.push(
			`- Final response for multi-file changes: ${discipline.finalResponse.multiFileMaxWords} words maximum. Summarize intent and scope.`,
		)
	}

	return `## Output Discipline\n${lines.join('\n')}`
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
			outputDiscipline: override.reflexes?.outputDiscipline ?? base.reflexes?.outputDiscipline,
		},
		output: override.output ?? base.output,
		sessionContext: override.sessionContext ?? base.sessionContext,
	}
}

export function withSessionContext(persona: AgentPersona, sessionContext: string): AgentPersona {
	return { ...persona, sessionContext }
}
