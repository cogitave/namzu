import { join } from 'node:path'
import { GENAI, NAMZU } from '../../constants/telemetry/index.js'
import { PlanManager } from '../../manager/plan/lifecycle.js'
import { TurnRecorder } from '../../manager/session/turn-recorder.js'
import type { SessionTokenBudget } from '../../store/budget/index.js'
import { SPILL_DIR } from '../../store/session-log/index.js'
import { ActivityStore } from '../../store/activity/memory.js'
import { type ActivityTrackingConfig, resolveActivityTracking } from '../../types/activity/index.js'
import type { SessionId, TenantId, TurnId } from '../../types/ids/index.js'
import type { PermissionMode } from '../../types/permission/index.js'
import type { LLMProvider } from '../../types/provider/index.js'
import type { TurnConfig } from '../../types/session/config.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import type { ModelPricing } from '../../utils/cost.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import type { SessionStorage } from './session-storage.js'

/**
 * Config accepted by {@link TurnContextFactory.build}. `sessionId`,
 * `topicId`, `projectId`, and `tenantId` are required — a turn carries the
 * full scope (Tenant → Project → Topic → Session → Turn).
 */
export interface TurnContextConfig {
	budget?: SessionTokenBudget
	/**
	 * The mode this conversation was left in, when the turn config names none.
	 * An explicit `TurnConfig.permissionMode` outranks it.
	 */
	topicPermissionMode?: PermissionMode

	/**
	 * The live mode box, when the caller wants to hold it too, so whoever
	 * builds the coordinator tools can flip the mode from an approval hook and
	 * have the executor see it within the same turn.
	 */
	permissionModeRef?: { current: PermissionMode }

	agentId: string
	agentName: string
	turnConfig: TurnConfig
	provider: LLMProvider
	workingDirectory?: string
	pricing?: ModelPricing
	enableActivityTracking?: boolean
	signal?: AbortSignal

	sessionId: SessionId
	topicId: TopicId
	projectId: ProjectId
	tenantId: TenantId

	/** Where the session's log, checkpoints and ledger live. */
	storage: SessionStorage

	turnId: TurnId

	parentSessionId?: SessionId
	parentTurnId?: TurnId

	depth?: number

	/**
	 * A pre-built, already-correlated logger — what
	 * {@link TurnContextFactory.buildLogger} returns — so the provider retry
	 * and fallback wrappers and the turn share one `namzu.turn.id`.
	 */
	log?: Logger
}

/** Result of {@link TurnContextFactory.build}. */
export interface TurnContext {
	turnId: TurnId
	sessionId: SessionId
	topicId: TopicId
	projectId: ProjectId
	tenantId: TenantId
	recorder: TurnRecorder
	storage: SessionStorage
	activityStore: ActivityStore
	planManager: PlanManager
	abortController: AbortController
	cwd: string
	/** Where oversized tool output is spilled (`<session-id>/tool-results/`); absent for an in-memory session. */
	toolResultsDir: string | undefined
	/**
	 * The mode RIGHT NOW, not the one this turn started in: an approval inside
	 * a turn can change it and the executor reads through the same box.
	 */
	permissionMode: { current: PermissionMode }
	log: Logger
	trackingConfig: ActivityTrackingConfig
}

export class TurnContextFactory {
	/**
	 * The turn's one correlated logger, built once and handed to every
	 * consumer: the provider retry and fallback wrappers are themselves inputs
	 * to `build`, so the logger has to exist before `build` runs.
	 *
	 * The base logger comes from `resolveLogger`, so a host that set
	 * `turnConfig.logger` gets its own logger as the base `.child()` is called
	 * on: correlation is layered on top, the source is not replaced.
	 */
	static buildLogger(
		config: Pick<
			TurnContextConfig,
			| 'agentName'
			| 'turnConfig'
			| 'sessionId'
			| 'topicId'
			| 'projectId'
			| 'tenantId'
			| 'parentSessionId'
			| 'turnId'
		>,
	): Logger {
		return resolveLogger(config.turnConfig.logger).child({
			[SCOPE_ATTRIBUTE]: 'runtime/query',
			[GENAI.AGENT_NAME]: config.agentName,
			[NAMZU.TURN_ID]: config.turnId,
			...(config.parentSessionId ? { [NAMZU.SESSION_PARENT_ID]: config.parentSessionId } : {}),
			[NAMZU.SESSION_ID]: config.sessionId,
			[NAMZU.THREAD_ID]: config.topicId,
			[NAMZU.PROJECT_ID]: config.projectId,
			[NAMZU.TENANT_ID]: config.tenantId,
		})
	}

	static build(config: TurnContextConfig): TurnContext {
		const abortController = new AbortController()
		if (config.signal) {
			// Forward the caller's REASON, not just the fact of the abort, and
			// mirror an abort that already happened: AbortSignal does not replay
			// an event that fired before the listener was installed.
			if (config.signal.aborted) {
				abortController.abort(config.signal.reason)
			} else {
				config.signal.addEventListener(
					'abort',
					() => abortController.abort(config.signal?.reason),
					{ once: true },
				)
			}
		}

		const cwd = config.workingDirectory ?? process.cwd()
		// An explicit `TurnConfig.permissionMode` still wins; the topic record
		// supplies the mode only when the turn config names none.
		const seeded = config.turnConfig.permissionMode ?? config.topicPermissionMode ?? 'auto'
		const permissionMode = config.permissionModeRef ?? { current: seeded }
		permissionMode.current = seeded

		const log = config.log ?? TurnContextFactory.buildLogger(config)

		const recorder = new TurnRecorder({
			turnId: config.turnId,
			budget: config.budget,
			agentId: config.agentId,
			agentName: config.agentName,
			turnConfig: config.turnConfig,
			providerId: config.provider.id,
			pricing: config.pricing,
			log,
			sessionId: config.sessionId,
			topicId: config.topicId,
			tenantId: config.tenantId,
			projectId: config.projectId,
			...(config.parentSessionId ? { parentSessionId: config.parentSessionId } : {}),
			...(config.parentTurnId ? { parentTurnId: config.parentTurnId } : {}),
			...(config.depth !== undefined ? { depth: config.depth } : {}),
			sessionLog: config.storage.log,
			checkpointStore: config.storage.checkpoints,
		})

		const trackingConfig = resolveActivityTracking(
			permissionMode.current,
			config.enableActivityTracking,
		)
		const activityStore = new ActivityStore(config.turnId, trackingConfig)
		const planManager = new PlanManager({ sessionId: config.sessionId, turnId: config.turnId })
		const toolResultsDir =
			config.storage.sessionDir === undefined
				? undefined
				: join(config.storage.sessionDir, SPILL_DIR)

		return {
			turnId: config.turnId,
			sessionId: config.sessionId,
			topicId: config.topicId,
			projectId: config.projectId,
			tenantId: config.tenantId,
			recorder,
			storage: config.storage,
			activityStore,
			planManager,
			abortController,
			cwd,
			toolResultsDir,
			permissionMode,
			log,
			trackingConfig,
		}
	}
}
