import type { AgentInfo } from '../../contracts/index.js'
import type { A2AAgentCard, A2AAgentSkill, A2AServerConfig } from '../../types/a2a/index.js'
import type { Skill } from '../../types/skills/index.js'

const A2A_PROTOCOL_VERSION = '0.3.0'

function toolToA2ASkill(toolName: string): A2AAgentSkill {
	return {
		id: `tool-${toolName}`,
		name: toolName,
		description: `Execute ${toolName} tool`,
		tags: ['tool'],
	}
}

function skillToA2ASkill(skill: Skill): A2AAgentSkill {
	return {
		id: skill.metadata.name,
		name: skill.metadata.name,
		description: skill.metadata.description,
		tags: ['procedure'],
	}
}

export function buildAgentCard(
	info: AgentInfo,
	config: A2AServerConfig,
	skills?: readonly Skill[],
): A2AAgentCard {
	const a2aSkills: A2AAgentSkill[] = []

	for (const toolName of info.tools) {
		a2aSkills.push(toolToA2ASkill(toolName))
	}

	if (skills) {
		for (const skill of skills) {
			a2aSkills.push(skillToA2ASkill(skill))
		}
	}

	return {
		name: info.name,
		description: info.description,
		version: info.version,
		protocolVersion: A2A_PROTOCOL_VERSION,
		provider: {
			organization: config.providerOrganization ?? 'Namzu',
			url: config.providerUrl,
		},
		capabilities: {
			streaming: info.capabilities?.supportsStreaming ?? false,
			pushNotifications: false,
			extendedAgentCard: false,
		},
		defaultInputModes: ['text'],
		defaultOutputModes: ['text'],
		skills: a2aSkills,
		supportedInterfaces: [
			{
				url: `${config.baseUrl}/a2a/${info.id}`,
				transport: config.transport,
			},
		],
		securitySchemes: {
			bearer: {
				type: 'http',
				scheme: 'bearer',
			},
		},
		securityRequirements: [{ bearer: [] }],
	}
}
