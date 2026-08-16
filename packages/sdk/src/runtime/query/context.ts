import { join } from 'node:path'
import { GENAI, NAMZU } from '../../constants/telemetry/index.js'
import { PlanManager } from '../../manager/plan/lifecycle.js'
import { RunPersistence } from '../../manager/run/persistence.js'
import {
	DefaultFilesystemMigrator,
	type FilesystemMigrationResult,
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
import type { CheckpointStore } from '../../types/run/checkpoint-store.js'
import type { AgentRunConfig } from '../../types/run/index.js'
import type { RunStore } from '../../types/run/store.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import type { ModelPricing } from '../../utils/cost.js'
import { generateRunId } from '../../utils/id.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'

/**
 * Config accepted by {@link RunContextFactory.build}. `sessionId`,
 * `topicId`, `projectId`, and `tenantId` are required — runs carry the full
 * five-layer scope (Tenant → Project → Topic → Session → Run) per
 * Convention #17.
 *
 * `pathBuilder` is optional; when absent a {@link DefaultPathBuilder} is
 * constructed against `{workingDirectory}/.namzu`.
 *
 * `filesystemMigrator` is optional, but note what `build` actually does
 * with it: nothing. Migration is not part of `build` — it runs once per
 * process via {@link RunContextFactory.ensureMigrated}, kept out of `build`
 * entirely so the static method stays synchronous for existing callers;
 * `query()` calls `ensureMigrated` itself, with its own migrator, before it
 * ever calls `build`. This field predates that split, and no code path
 * threads it to `ensureMigrated` on `build`'s behalf. Its sibling
 * `migrationSink` had the identical shape — declared, never read anywhere
 * in the workspace — and NZ-BOOT-04 removed it
 * (`docs/conventions/declared-but-undriven.md`) rather than invent a caller
 * for a field nothing needed; `filesystemMigrator` is the same defect, left
 * for a follow-up rather than folded into that change.
 */
export interface RunContextConfig {
	/**
	 * The mode this conversation was left in, when the run config names none.
	 *
	 * Read from the Topic's state record by `query()`. An explicit
	 * `RunConfig.permissionMode` outranks it, which is what keeps every
	 * existing caller byte-identical.
	 */
	topicPermissionMode?: PermissionMode

	/**
	 * The live mode box, when the caller wants to hold it too.
	 *
	 * Supplied rather than created here so whoever builds the coordinator
	 * tools — which is not this function — can flip the mode from an
	 * approval hook and have the executor see it. Without a shared handle
	 * the approval could persist the change and the RUNNING run would go on
	 * refusing writes, which is the confusing half-state this whole task
	 * exists to remove.
	 */
	permissionModeRef?: { current: PermissionMode }

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
	topicId: TopicId
	projectId: ProjectId
	tenantId: TenantId

	pathBuilder?: PathBuilder

	/**
	 * Optional checkpoint persistence override, threaded through to
	 * {@link RunPersistence}. Absent ⇒ disk default under the run's
	 * output directory.
	 */
	checkpointStore?: CheckpointStore
	runStore?: RunStore

	/**
	 * Optional injected migrator — tests pass a stub; production code relies
	 * on the {@link DefaultFilesystemMigrator}. See session-hierarchy.md
	 * §13.4.1.
	 */
	filesystemMigrator?: FilesystemMigrator

	runId?: RunId

	parentRunId?: RunId

	depth?: number

	/**
	 * A pre-built, already-correlated logger — what {@link RunContextFactory.buildLogger} returns. When present, `build` uses this instead of constructing its own, which is what lets a caller hand the SAME logger to `withProviderRetry`/`withProviderFallback` (themselves inputs to `build` — see `runtime/query/index.ts`) and to the `RunContext` this config becomes, rather than each reaching for its own child of `getRootLogger()` and losing the guarantee that a retry warning and the run it retried for share one `namzu.run.id`. Absent means what it always meant: `build` derives its own via `buildLogger`.
	 */
	log?: Logger
}

/** Result of {@link RunContextFactory.build}. */
export interface RunContext {
	runId: RunId
	sessionId: SessionId
	topicId: TopicId
	projectId: ProjectId
	tenantId: TenantId
	runMgr: RunPersistence
	activityStore: ActivityStore
	planManager: PlanManager
	abortController: AbortController
	cwd: string
	outputDir: string
	/**
	 * The mode RIGHT NOW, not the one this run started in.
	 *
	 * A box rather than a value, because an approval inside a run can change
	 * it and the executor reads through the same box — see
	 * `ToolExecutorConfig.permissionMode`. The run used to freeze it at
	 * start, so leaving plan mode meant ending the run.
	 */
	permissionMode: { current: PermissionMode }
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

	/**
	 * The run's one correlated logger, built once and handed to every
	 * consumer that used to construct its own. Split out of `build` because
	 * `build` is not the first thing in `query()` that needs a logger: the
	 * provider retry and fallback wrappers (`runtime/query/index.ts`) are
	 * THEMSELVES inputs to `build` (`resilientProvider`), so a caller has to
	 * be able to get a correlated logger BEFORE `build` runs, not after —
	 * the reordering the design's own boundary table found does not
	 * type-check when attempted the other way round.
	 *
	 * `runId` is a REQUIRED field here, not the `config.runId ??
	 * generateRunId()` fallback `build` still does for its own direct
	 * callers below. The whole reason to extract this is that the SAME id
	 * ends up bound on the log and stamped onto the `RunContext` it is
	 * later attached to — generating it twice, once here and once in
	 * `build`, would silently hand the log and the run two different ids.
	 * The caller (`query()`) resolves the id once and passes it to both
	 * this and `build`.
	 *
	 * The base logger comes from `resolveLogger`, not `getRootLogger`
	 * directly — the fallback-to-the-process-default read now lives there
	 * instead of duplicated at every site that used to reach for the global
	 * on its own. A host that set `runConfig.logger` gets ITS OWN logger as
	 * the base `.child()` is called on, so every record this run's retry
	 * and fallback wrappers write still reaches the host's destination:
	 * `buildLogger` layers correlation on top, it does not replace the
	 * source.
	 */
	static buildLogger(
		config: Pick<
			RunContextConfig,
			'agentName' | 'runConfig' | 'sessionId' | 'topicId' | 'projectId' | 'tenantId' | 'parentRunId'
		> & {
			runId: RunId
		},
	): Logger {
		return resolveLogger(config.runConfig.logger).child({
			[SCOPE_ATTRIBUTE]: 'runtime/query',
			[GENAI.AGENT_NAME]: config.agentName,
			[NAMZU.RUN_ID]: config.runId,
			...(config.parentRunId ? { [NAMZU.RUN_PARENT_ID]: config.parentRunId } : {}),
			[NAMZU.SESSION_ID]: config.sessionId,
			[NAMZU.THREAD_ID]: config.topicId,
			[NAMZU.PROJECT_ID]: config.projectId,
			[NAMZU.TENANT_ID]: config.tenantId,
		})
	}

	static build(config: RunContextConfig): RunContext {
		const abortController = new AbortController()
		if (config.signal) {
			// Forward the caller's REASON, not just the fact of the abort.
			//
			// This used to be a bare `abort()`. Every word a host attached to
			// its stop — a deadline name, a budget, an operator's message —
			// died one frame above the executor, so the most a tool result
			// could say was "was cancelled". A run that ends for a nameable
			// reason is a run someone can debug; this is the frame where the
			// name was being thrown away.
			//
			// `createChildAbortController` already does exactly this, but it
			// takes an AbortController and what arrives here is a bare
			// AbortSignal, so the reason is forwarded by hand rather than by
			// reaching for a helper that does not fit.
			config.signal.addEventListener('abort', () => abortController.abort(config.signal?.reason), {
				once: true,
			})
		}

		const cwd = config.workingDirectory ?? process.cwd()
		// An explicit `RunConfig.permissionMode` still wins — this is the
		// no-behaviour-change guarantee for every existing caller. The topic
		// record supplies the mode only when the run config names none, and
		// `resolveTopicPermissionMode` in `query()` is what reads it.
		const seeded = config.runConfig.permissionMode ?? config.topicPermissionMode ?? 'auto'
		const permissionMode = config.permissionModeRef ?? { current: seeded }
		// Seeded even when supplied: the caller creates the box before it can
		// know what the run config or the topic record say, so leaving its
		// initial value in place would ignore both.
		permissionMode.current = seeded
		const runId = config.runId ?? generateRunId()

		const pathBuilder = config.pathBuilder ?? new DefaultPathBuilder(join(cwd, '.namzu'))
		const outputDir = pathBuilder.sessionDir(config.projectId, config.sessionId)
		const runsDir = join(outputDir, 'runs')

		const log = config.log ?? RunContextFactory.buildLogger({ ...config, runId })

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
			topicId: config.topicId,
			tenantId: config.tenantId,
			projectId: config.projectId,
			parentRunId: config.parentRunId,
			depth: config.depth,
			checkpointStore: config.checkpointStore,
			runStore: config.runStore,
		})

		const trackingConfig = resolveActivityTracking(
			permissionMode.current,
			config.enableActivityTracking,
		)
		const activityStore = new ActivityStore(runId, trackingConfig)
		const planManager = new PlanManager(runId)

		return {
			runId,
			sessionId: config.sessionId,
			topicId: config.topicId,
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
