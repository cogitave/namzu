import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, relative, sep } from 'node:path'
import { posix } from 'node:path'
import type {
	SharedRunWorkspaceAgentRecord,
	SharedRunWorkspaceManifest,
	SharedRunWorkspacePlan,
	SharedRunWorkspaceRefs,
	SharedRunWorkspaceSource,
} from '../../types/workspace/shared-run.js'

export interface SharedRunWorkspaceConfig {
	/**
	 * Host-visible `_work` directory. The runtime creates and mutates files
	 * here before/while agents execute.
	 */
	hostRoot: string
	/**
	 * Agent-visible `_work` directory. In container sandboxes this is usually
	 * `/mnt/user-data/outputs/_work`; in local mode it can be the same
	 * relative path agents receive in their runtime notes.
	 */
	runtimeRoot?: string
	label?: string
	now?: Date
}

export interface RegisterSharedRunPlanInput {
	id?: string
	briefText: string
	status?: SharedRunWorkspacePlan['status']
}

export class SharedRunWorkspace {
	readonly hostRoot: string
	readonly runtimeRoot: string

	private constructor(private readonly config: Required<SharedRunWorkspaceConfig>) {
		this.hostRoot = config.hostRoot
		this.runtimeRoot = trimTrailingSlash(config.runtimeRoot)
	}

	static async create(config: SharedRunWorkspaceConfig): Promise<SharedRunWorkspace> {
		const workspace = new SharedRunWorkspace({
			hostRoot: config.hostRoot,
			runtimeRoot: config.runtimeRoot ?? config.hostRoot,
			label: config.label ?? '',
			now: config.now ?? new Date(),
		})
		await workspace.ensure()
		return workspace
	}

	refs(): SharedRunWorkspaceRefs {
		return {
			rootPath: this.runtimePath(),
			manifestPath: this.runtimePath('manifest.json'),
			sourceInventoryPath: this.runtimePath('sources', 'inventory.md'),
			supervisorBriefPath: this.runtimePath('00_supervisor_brief.md'),
			agentsPath: this.runtimePath('agents'),
		}
	}

	hostPath(...segments: string[]): string {
		return safeJoin(this.hostRoot, segments)
	}

	runtimePath(...segments: string[]): string {
		if (segments.length === 0) return this.runtimeRoot
		return posix.join(this.runtimeRoot, ...segments.map((segment) => segment.split(sep).join('/')))
	}

	async ensure(): Promise<void> {
		await Promise.all([
			mkdir(this.hostPath('sources'), { recursive: true }),
			mkdir(this.hostPath('plans', 'root'), { recursive: true }),
			mkdir(this.hostPath('agents'), { recursive: true }),
		])
		await this.writeManifest((manifest) => manifest)
	}

	async readManifest(): Promise<SharedRunWorkspaceManifest> {
		const content = await readFile(this.hostPath('manifest.json'), 'utf8').catch(() => '')
		if (!content.trim()) return this.initialManifest()
		return JSON.parse(content) as SharedRunWorkspaceManifest
	}

	async writeManifest(
		update: (manifest: SharedRunWorkspaceManifest) => SharedRunWorkspaceManifest,
	): Promise<SharedRunWorkspaceManifest> {
		const current = await this.readManifest().catch(() => this.initialManifest())
		const next = update({
			...current,
			updatedAt: this.nowIso(),
		})
		await writeFile(this.hostPath('manifest.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
		return next
	}

	async writeSourceInventory(sources: readonly SharedRunWorkspaceSource[]): Promise<string> {
		const lines = [
			'# Source Inventory',
			'',
			sources.length
				? 'These are the canonical input references for this run. Prefer this inventory and targeted source reads over rediscovering uploads in every worker.'
				: 'No user-uploaded source files were registered for this run.',
			'',
			...sources.map((source) =>
				[
					`## ${source.label}`,
					'',
					`- id: ${source.id}`,
					`- path: ${source.path}`,
					source.kind ? `- kind: ${source.kind}` : null,
					typeof source.sizeBytes === 'number' ? `- sizeBytes: ${source.sizeBytes}` : null,
					'',
				]
					.filter((line): line is string => line !== null)
					.join('\n'),
			),
		]
		const content = `${lines.join('\n').trimEnd()}\n`
		await writeFile(this.hostPath('sources', 'inventory.md'), content, 'utf8')
		await this.writeManifest((manifest) => ({
			...manifest,
			sources: [...sources],
		}))
		return this.runtimePath('sources', 'inventory.md')
	}

	async seedSupervisorBrief(input: RegisterSharedRunPlanInput): Promise<string> {
		const id = input.id ?? 'root'
		const relativePath =
			id === 'root' ? ['00_supervisor_brief.md'] : ['plans', id, 'supervisor_brief.md']
		await mkdir(dirnameFor(this.hostPath(...relativePath)), { recursive: true })
		await writeFile(this.hostPath(...relativePath), ensureTrailingNewline(input.briefText), 'utf8')
		const briefPath = this.runtimePath(...relativePath)
		const now = this.nowIso()
		await this.writeManifest((manifest) => ({
			...manifest,
			plans: upsertBy(manifest.plans, (plan) => plan.id, {
				id,
				briefPath,
				status: input.status ?? 'seeded',
				updatedAt: now,
			}),
		}))
		return briefPath
	}

	async registerAgentWork(input: {
		agentId: string
		taskId?: string
		status?: SharedRunWorkspaceAgentRecord['status']
	}): Promise<string> {
		const taskPart = input.taskId ?? 'pending'
		const relativePath = ['agents', input.agentId, taskPart]
		await mkdir(this.hostPath(...relativePath), { recursive: true })
		const workPath = this.runtimePath(...relativePath)
		const now = this.nowIso()
		await this.writeManifest((manifest) => ({
			...manifest,
			agents: upsertBy(manifest.agents, (record) => `${record.agentId}:${record.taskId ?? ''}`, {
				agentId: input.agentId,
				...(input.taskId ? { taskId: input.taskId } : {}),
				workPath,
				status: input.status ?? 'assigned',
				updatedAt: now,
			}),
		}))
		return workPath
	}

	private initialManifest(): SharedRunWorkspaceManifest {
		const now = this.config.now.toISOString()
		return {
			schemaVersion: 1,
			kind: 'shared-run-workspace',
			createdAt: now,
			updatedAt: now,
			...(this.config.label ? { label: this.config.label } : {}),
			paths: {
				root: this.runtimePath(),
				manifest: this.runtimePath('manifest.json'),
				sources: this.runtimePath('sources'),
				plans: this.runtimePath('plans'),
				agents: this.runtimePath('agents'),
			},
			sources: [],
			plans: [],
			agents: [],
		}
	}

	private nowIso(): string {
		return new Date().toISOString()
	}
}

function safeJoin(root: string, segments: readonly string[]): string {
	const fullPath = normalize(join(root, ...segments))
	const rel = relative(root, fullPath)
	if (rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`))) return fullPath
	throw new Error(`SharedRunWorkspace path escapes root: ${segments.join('/')}`)
}

function trimTrailingSlash(value: string): string {
	if (value === '/') return value
	return value.replace(/\/+$/, '')
}

function ensureTrailingNewline(value: string): string {
	return value.endsWith('\n') ? value : `${value}\n`
}

function dirnameFor(path: string): string {
	return dirname(path)
}

function upsertBy<T>(items: readonly T[], key: (item: T) => string, next: T): T[] {
	const nextKey = key(next)
	let replaced = false
	const updated = items.map((item) => {
		if (key(item) !== nextKey) return item
		replaced = true
		return next
	})
	return replaced ? updated : [...updated, next]
}
