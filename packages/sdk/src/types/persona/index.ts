export type PersonaLayer =
	| 'system'
	| 'identity'
	| 'expertise'
	| 'reflexes'
	| 'skills'
	| 'tools'
	| 'output'
	| 'task-context'

export interface PersonaIdentity {
	role: string

	description: string
}

export interface PersonaExpertise {
	domains: string[]
}

export interface OutputDiscipline {
	betweenToolCalls: 'silent' | 'minimal'
	finalResponse?: {
		singleFileMaxWords?: number
		multiFileMaxWords?: number
	}
	suppressInnerMonologue?: boolean
}

export interface PersonaReflexes {
	constraints: string[]

	toolGuidance?: string

	outputDiscipline?: OutputDiscipline
}

export interface PersonaOutput {
	format: string
}

export interface AgentPersona {
	identity: PersonaIdentity
	expertise?: PersonaExpertise
	reflexes?: PersonaReflexes
	output?: PersonaOutput
	sessionContext?: string
}

export interface BehavioralConstraints {
	prohibitions: string[]
	requirements?: string[]
	scope?: string
}

export interface PersonaDefinition {
	schemaVersion: 1
	agentId?: string
	personaId?: string

	extends?: string
	identity: PersonaIdentity
	expertise?: PersonaExpertise
	reflexes?: PersonaReflexes
	output?: PersonaOutput
}
