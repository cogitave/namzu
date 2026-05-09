export interface SharedRunWorkspacePaths {
	root: string
	manifest: string
	sources: string
	plans: string
	agents: string
}

export interface SharedRunWorkspaceSource {
	id: string
	label: string
	path: string
	kind?: string
	sizeBytes?: number
}

export interface SharedRunWorkspacePlan {
	id: string
	briefPath: string
	status: 'seeded' | 'ready' | 'running' | 'completed' | 'failed'
	updatedAt: string
}

export interface SharedRunWorkspaceAgentRecord {
	agentId: string
	taskId?: string
	workPath: string
	status: 'assigned' | 'running' | 'completed' | 'failed' | 'canceled'
	updatedAt: string
}

export interface SharedRunWorkspaceManifest {
	schemaVersion: 1
	kind: 'shared-run-workspace'
	createdAt: string
	updatedAt: string
	label?: string
	paths: SharedRunWorkspacePaths
	sources: SharedRunWorkspaceSource[]
	plans: SharedRunWorkspacePlan[]
	agents: SharedRunWorkspaceAgentRecord[]
}

export interface SharedRunWorkspaceRefs {
	rootPath: string
	manifestPath: string
	sourceInventoryPath: string
	supervisorBriefPath: string
	agentsPath: string
}
