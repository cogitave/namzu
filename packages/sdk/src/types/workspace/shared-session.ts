export interface SharedSessionWorkspacePaths {
	root: string
	manifest: string
	sharedContext: string
	sources: string
	plans: string
	agents: string
}

export interface SharedSessionWorkspaceSource {
	id: string
	label: string
	path: string
	kind?: string
	sizeBytes?: number
}

export interface SharedSessionWorkspacePlan {
	id: string
	briefPath: string
	status: 'seeded' | 'ready' | 'running' | 'completed' | 'failed'
	updatedAt: string
}

export interface SharedSessionWorkspaceAgentRecord {
	agentId: string
	taskId?: string
	workPath: string
	status: 'assigned' | 'running' | 'completed' | 'failed' | 'canceled'
	updatedAt: string
}

export interface SharedSessionWorkspaceManifest {
	schemaVersion: 1
	kind: 'shared-session-workspace'
	createdAt: string
	updatedAt: string
	label?: string
	paths: SharedSessionWorkspacePaths
	sources: SharedSessionWorkspaceSource[]
	plans: SharedSessionWorkspacePlan[]
	agents: SharedSessionWorkspaceAgentRecord[]
}

export interface SharedSessionWorkspaceRefs {
	rootPath: string
	manifestPath: string
	/**
	 * Path to the shared coordination packet for this session. Workers read this
	 * before the larger task context or source inventory so common runtime
	 * instructions, source summaries, and workspace paths are not rediscovered
	 * independently by every specialist.
	 */
	sharedContextPath: string
	sourceInventoryPath: string
	supervisorBriefPath: string
	/**
	 * Path to the canonical, full-fidelity user task description for this session.
	 * Workers read this instead of receiving the user's request text inline in
	 * every child prompt — keeps child prompts compact and lets the request
	 * grow without bloating per-worker handoffs.
	 */
	taskContextPath: string
	agentsPath: string
}
