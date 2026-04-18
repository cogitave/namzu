import { join } from 'node:path'
import { PlanManager } from '../../manager/plan/lifecycle.js'
import { RunPersistence } from '../../manager/run/persistence.js'
import {
	DefaultFilesystemMigrator,
	type FilesystemMigrationResult,
	type FilesystemMigrationSink,
	type FilesystemMigrator,
	NOOP_FILESYSTEM_MIGRATION_SINK,
} from '../../session/migration/index.js'
import { DefaultPathBuilder, type PathBuilder } from '../../session/workspace/path-builder.js'
import { ActivityStore } from '../../store/activity/memory.js'
import { type ActivityTrackingConfig, resolveActivityTracking } from '../../types/activity/index.js'
import type { RunId, SessionId, TenantId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import type { PermissionMode } from '../../types/permission/index.js'
import type { LLMProvider } from '../../types/provider/index.js'
import type { AgentRunConfig } from '../../types/run/index.js'
import type { ProjectId } from '../../types/session/ids.js'
import type { ModelPricing } from '../../utils/cost.js'
import { generateRunId } from '../../utils/id.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'

/**
 * Config accepted by {@link RunContextFactory.build}. `sessionId`,
 * `projectId`, and `tenantId` are required — runs are scoped under a Session
 * within a Project within a Tenant (Convention #17).
 *
 * `pathBuilder` is optional; when absent a {@link DefaultPathBuilder} is
 * constructed against `{workingDirectory}/.namzu`.
 *
 * `filesystemMigrator` + `migrationSink` are optional; when absent a
 * {@link DefaultFilesystemMigrator} wired to the
 * {@link NOOP_FILESYSTEM_MIGRATION_SINK} is used. Migration runs once per
 * process via {@link RunContextFactory.ensureMigrated}; the static `build`
 * method stays synchronous so existing call sites are not broken — async
 * callers (e.g. `query()`) invoke `ensureMigrated` themselves before build.
 */
export interface RunContextConfig {
	agentId: string
	agentName: string
	runConfig: AgentRunConfig
	provider: LLMProvider
	workingDirectory?: string
	pricing?: ModelPricing
	enableActivityTracking?: boolean
	messages: Message[]
	signal?: AbortSignal

	sessionId: SessionId
	projectId: ProjectId
	tenantId: TenantId

	pathBuilder?: PathBuilder

	/**
	 * Optional injected migrator — tests pass a stub; production code relies
	 * on the {@link DefaultFilesystemMigrator}. See session-hierarchy.md
	 * §13.4.1.
	 */
	filesystemMigrator?: FilesystemMigrator

	/** Optional sink for `filesystem.migrated` events. Defaults to no-op. */
	migrationSink?: FilesystemMigrationSink

	runId?: RunId

	parentRunId?: RunId

	depth?: number
}

/** Result of {@link RunContextFactory.build}. */
export interface RunContext {
	runId: RunId
	sessionId: SessionId
	projectId: ProjectId
	tenantId: TenantId
	runMgr: RunPersistence
	activityStore: ActivityStore
	planManager: PlanManager
	abortController: AbortController
	cwd: string
	outputDir: string
	permissionMode: PermissionMode
	log: Logger
	trackingConfig: ActivityTrackingConfig
}

/**
 * Module-level first-call guard for the boot-time filesystem migration
 * (session-hierarchy.md §13.4.1). Keyed on the root directory so a single
 * process that spans multiple `.namzu` roots (unusual but legal) migrates
 * each one once. Subsequent calls short-circuit via the cached promise —
 * never re-reading the on-disk marker per call.
 */
const migrationPromises = new Map<string, Promise<FilesystemMigrationResult>>()

/** Testing hook — clears the first-call guard cache. */
export function __resetMigrationGuardForTests(): void {
	migrationPromises.clear()
}

export class RunContextFactory {
	/**
	 * Run the boot-time filesystem migration for `rootDir` at most once per
	 * process. Safe to `await` from any async entry point; concurrent callers
	 * for the same root share a single migration promise (no duplicate work,
	 * no race with the on-disk `.tmp` lock).
	 */
	static ensureMigrated(
		rootDir: string,
		migrator: FilesystemMigrator = new DefaultFilesystemMigrator(NOOP_FILESYSTEM_MIGRATION_SINK),
	): Promise<FilesystemMigrationResult> {
		const cached = migrationPromises.get(rootDir)
		if (cached) return cached
		const promise = migrator.migrate(rootDir)
		migrationPromises.set(rootDir, promise)
		// Crash-safety: if the migration rejects, drop the cached promise so
		// the next caller gets a fresh attempt. Successful results stay cached
		// (idempotency — further calls short-circuit without re-running).
		promise.catch(() => {
			migrationPromises.delete(rootDir)
		})
		return promise
	}

	static build(config: RunContextConfig): RunContext {
		const abortController = new AbortController()
		if (config.signal) {
			config.signal.addEventListener('abort', () => abortController.abort(), { once: true })
		}

		const cwd = config.workingDirectory ?? process.cwd()
		const permissionMode = config.runConfig.permissionMode ?? 'auto'
		const runId = config.runId ?? generateRunId()

		const pathBuilder = config.pathBuilder ?? new DefaultPathBuilder(join(cwd, '.namzu'))
		const outputDir = pathBuilder.sessionDir(config.projectId, config.sessionId)
		const runsDir = join(outputDir, 'runs')

		const log = getRootLogger().child({
			component: 'query',
			agent: config.agentName,
			runId,
			sessionId: config.sessionId,
			projectId: config.projectId,
			tenantId: config.tenantId,
		})

		const runMgr = new RunPersistence({
			runId,
			agentId: config.agentId,
			agentName: config.agentName,
			runConfig: config.runConfig,
			providerId: config.provider.id,
			outputDir: runsDir,
			pricing: config.pricing,
			log,
			sessionId: config.sessionId,
			tenantId: config.tenantId,
			projectId: config.projectId,
			parentRunId: config.parentRunId,
			depth: config.depth,
		})

		const trackingConfig = resolveActivityTracking(permissionMode, config.enableActivityTracking)
		const activityStore = new ActivityStore(runId, trackingConfig)
		const planManager = new PlanManager(runId)

		return {
			runId,
			sessionId: config.sessionId,
			projectId: config.projectId,
			tenantId: config.tenantId,
			runMgr,
			activityStore,
			planManager,
			abortController,
			cwd,
			outputDir,
			permissionMode,
			log,
			trackingConfig,
		}
	}
}
