export interface SkillMetadata {
	name: string

	description: string

	compatibility?: string

	metadata?: Record<string, string>
}

export interface Skill {
	metadata: SkillMetadata

	body?: string

	dirPath: string
}

export type SkillDisclosureLevel = 'metadata' | 'full' | 'assets'

export interface SkillLoadResult {
	skill: Skill
	disclosureLevel: SkillDisclosureLevel

	tokenEstimate: number
}

export interface SkillChain {
	inherited: Skill[]

	own: Skill[]

	resolved: Skill[]
}
