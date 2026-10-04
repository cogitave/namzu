import type { ReviewMode } from '../../runtime/query/review-policy.js'
import type { SessionLog } from '../../store/session-log/index.js'
/**
 * A session whose execution and tools belong to a host-composed external harness.
 * SDK code contains no vendor import, process runner or credential discovery.
 * Existing Namzu query/LLMProvider/tool execution is unchanged.
 */
import type {
	MessageId,
	ProjectId,
	SessionId,
	TenantId,
	ToolUseId,
	TopicId,
	TurnId,
} from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { ReasoningEffort } from '../provider/index.js'
import type { SessionEvent } from '../session/events.js'

export type HarnessJson =
	| null
	| boolean
	| number
	| string
	| readonly HarnessJson[]
	| { readonly [key: string]: HarnessJson }

/** Native IDs remain opaque strings and are NEVER parsed as Namzu UUIDs. */
export interface HarnessBinding {
	readonly v: 1
	readonly engineId: string
	/** Host-owned opaque identity for executable/state-home/account selection; no credentials. */
	readonly profileRef: string
	/** Exact native conversation/thread identifier, not a shared root or Namzu session ID. */
	readonly nativeSessionId: string
	/** Canonical absolute native execution directory, confirmed by the adapter. */
	readonly cwd: string
	/** Verified initial selection; later changes are captured per turn, never engine changes. */
	readonly initialModel: string
}

export interface HarnessScope {
	readonly sessionId: SessionId
	readonly tenantId: TenantId
	readonly projectId: ProjectId
	readonly topicId: TopicId
	readonly cwd: string
}

/** Values established from the installed engine/protocol, never copied from Namzu providers. */
export interface HarnessCapabilities {
	readonly persistentSessions: boolean
	readonly history: 'snapshot' | 'unavailable'
	readonly models: 'discover' | 'configured' | 'unavailable'
	readonly permissions: 'interactive' | 'deny-only' | 'unavailable'
	readonly interrupt: 'native-terminal' | 'process-stop' | 'unavailable'
	readonly attachments: readonly ('image' | 'file')[]
	readonly effortLevels?: readonly ReasoningEffort[]
	/** Common UI may offer only modes actually mapped by this engine. */
	readonly reviewModes: readonly ReviewMode[]
}

export interface HarnessModel {
	readonly id: string
	readonly label: string
	readonly effortLevels?: readonly ReasoningEffort[]
	readonly defaultEffort?: ReasoningEffort
}

export interface HarnessNativeTurn {
	readonly nativeSessionId: string
	readonly nativeTurnId: string
	/** Explicit operation correlation when the engine exposes no native turn ID. */
	readonly turnIdSource?: 'engine' | 'operation'
}

export interface HarnessNativeItem extends HarnessNativeTurn {
	readonly nativeItemId: string
}

export interface HarnessPublicTextPart {
	readonly id: string
	readonly text: string
	readonly phase?: 'commentary' | 'final_answer'
}

export type HarnessDecision =
	| { readonly kind: 'approve-once'; readonly updatedInput?: HarnessJson }
	| { readonly kind: 'reject'; readonly feedback?: string }
	| { readonly kind: 'cancel' }

export interface HarnessReviewRequest extends HarnessNativeTurn {
	readonly requestId: string
	readonly nativeItemId?: string
	readonly kind: 'command' | 'file-change' | 'tool'
	readonly title: string
	/** Public proposed operation only. No raw RPC frame, credentials or private thinking. */
	readonly input: HarnessJson
	readonly decisions: readonly HarnessDecision['kind'][]
}

/** A NEW, namespaced port union. No new existing SessionEvent discriminants. */
export type HarnessEvent =
	| (HarnessNativeTurn & { readonly kind: 'turn-started'; readonly model?: string })
	| (HarnessNativeItem & { readonly kind: 'message-started' })
	| (HarnessNativeItem & {
			readonly kind: 'text-delta'
			readonly text: string
			readonly part?: Pick<HarnessPublicTextPart, 'id' | 'phase'>
	  })
	| (HarnessNativeItem & {
			readonly kind: 'message-completed'
			readonly content: string
			readonly parts?: readonly HarnessPublicTextPart[]
			readonly stopReason: import('../session/stop-reason.js').MessageStopReason
	  })
	| (HarnessNativeItem & {
			readonly kind: 'reasoning'
			readonly blockId: string
			readonly status: 'pending' | 'completed'
			/** Only engine-documented public summary/thinking; never replay/signature material. */
			readonly text?: string
	  })
	| (HarnessNativeItem & {
			readonly kind: 'tool-started'
			readonly name: string
			readonly input: HarnessJson
	  })
	| (HarnessNativeItem & { readonly kind: 'tool-output'; readonly text: string })
	| (HarnessNativeItem & {
			readonly kind: 'tool-completed'
			readonly name: string
			readonly result: string
			readonly status: 'completed' | 'failed' | 'declined' | 'cancelled'
			readonly durationMs?: number
	  })
	| { readonly kind: 'review-requested'; readonly request: HarnessReviewRequest }
	| (HarnessNativeTurn & { readonly kind: 'review-resolved'; readonly requestId: string })
	| (HarnessNativeTurn & {
			readonly kind: 'turn-completed'
			readonly status: 'completed' | 'failed' | 'cancelled'
			readonly finalItemId?: string
			readonly result?: string
			readonly error?: { readonly code: string; readonly message: string }
	  })
	| {
			readonly kind: 'connection-lost'
			readonly code: string
			/** True never implies that native work stopped. */
			readonly mayBeRunning: boolean
	  }

/** Resolve after validation/persistence/publication, never await a human answer here. */
export type HarnessEventSink = (event: HarnessEvent) => Promise<void>

export interface HarnessPrompt {
	/** Actual host operation identity for this admitted prompt, persisted before send. */
	readonly operationId: string
	readonly prompt: string
	readonly model: string
	readonly effort?: ReasoningEffort
	readonly permissionMode: ReviewMode
	readonly signal?: AbortSignal
}

export interface HarnessHistorySnapshot {
	readonly binding: HarnessBinding
	readonly activeTurn?: HarnessNativeTurn
	/** Authoritative lifecycle/items, not byte-for-byte replay of ephemeral deltas. */
	readonly events: readonly Exclude<
		HarnessEvent,
		{ readonly kind: 'text-delta' | 'tool-output' | 'connection-lost' }
	>[]
	readonly pendingReviews: readonly HarnessReviewRequest[]
	readonly complete: boolean
}

export interface HarnessConnection {
	readonly binding: HarnessBinding
	readonly capabilities: HarnessCapabilities
	models(signal?: AbortSignal): Promise<readonly HarnessModel[]>
	/** ACK may follow terminal event. It must not resurrect a finished turn. */
	dispatch(input: HarnessPrompt): Promise<HarnessNativeTurn>
	/** Receipt means requested only; SDK waits for correlated terminal/confirmed owned stop. */
	interrupt(turn: HarnessNativeTurn): Promise<{ readonly requested: true }>
	/** Validate exact current native request, then send one of that request's decisions. */
	respond(
		request: HarnessReviewRequest,
		decision: HarnessDecision,
	): Promise<{ readonly sent: true }>
	/** Never resends a prompt. Absence/incomplete history leaves explicit reconciliation required. */
	readHistory(signal?: AbortSignal): Promise<HarnessHistorySnapshot>
	/** Success confirms own process/children stopped; rejection retains handle for retry. */
	close(): Promise<{ readonly stopped: true }>
}

export interface HarnessAdapter {
	readonly engineId: string
	readonly profileRef: string
	/** Subscribe BEFORE spawn/initialize/open/resume so early items/requests cannot be lost. */
	open(
		input: {
			readonly cwd: string
			readonly model?: string
			readonly resume?: HarnessBinding
			readonly signal?: AbortSignal
		},
		onEvent: HarnessEventSink,
	): Promise<HarnessConnection>
}

export interface HarnessAdmissionRequest {
	readonly kind: 'open' | 'run' | 'approval' | 'reconnect'
	readonly scope: HarnessScope
	readonly binding?: HarnessBinding
	readonly nativeTurn?: HarnessNativeTurn
	readonly review?: HarnessReviewRequest
}

export interface HarnessSessionOptions {
	readonly scope: HarnessScope
	readonly sessionLog: SessionLog
	readonly adapter: HarnessAdapter
	/** REQUIRED current trusted host boundary: canonical cwd/trust/user ownership, ordinary only. */
	readonly assertAdmission: (
		request: HarnessAdmissionRequest,
		signal?: AbortSignal,
	) => Promise<void>
	readonly onEvent: (event: SessionEvent) => void | Promise<void>
	readonly onReview: (request: HarnessReviewRequest) => void | Promise<void>
}

export interface HarnessTurnOutcome {
	readonly turnId: TurnId
	readonly nativeTurn: HarnessNativeTurn
	readonly status: 'completed' | 'failed' | 'cancelled'
	readonly messages: readonly Message[]
}

export interface HarnessSession {
	readonly scope: HarnessScope
	readonly binding: HarnessBinding | undefined
	/** Exact admitted turn pointer for host cancellation; never a model-supplied ID. */
	readonly currentTurnId: TurnId | undefined
	readonly status:
		| 'disconnected'
		| 'idle'
		| 'running'
		| 'waiting'
		| 'reconciliation-required'
		| 'closed'
	/** Public durable text only; no native process startup. */
	history(): Promise<readonly Message[]>
	/** Reject concurrent turn operations. CLI/desktop owns its visible queue. */
	run(input: Omit<HarnessPrompt, 'operationId'>): Promise<HarnessTurnOutcome>
	/** Exact expected turn pointer prevents a stale Stop from cancelling the next turn. */
	cancel(expectedTurnId: TurnId): Promise<{ readonly stopped: true; readonly turnId: TurnId }>
	/** SDK adds current writer generation/request digest internally; renderer cannot supply authority. */
	respond(request: HarnessReviewRequest, decision: HarnessDecision): Promise<void>
	reconnect(signal?: AbortSignal): Promise<void>
	close(): Promise<void>
}

/** Typed journal receipts stored in the existing session_updated record. */
export type HarnessJournalTransition =
	| {
			readonly kind: 'dispatch-prepared'
			/** Actual admitted selection; engine binding remains immutable. */
			readonly model?: string
			readonly effort?: ReasoningEffort
			readonly permissionMode?: ReviewMode
			readonly operationId: string
			readonly turnId: TurnId
			readonly promptId: MessageId
			readonly digest: string
	  }
	| {
			readonly kind: 'dispatch-accepted'
			readonly operationId: string
			readonly turnId: TurnId
			readonly nativeTurn: HarnessNativeTurn
	  }
	| {
			readonly kind: 'item-bound'
			readonly turnId: TurnId
			readonly nativeItem: HarnessNativeItem
			readonly messageId?: MessageId
			readonly toolUseId?: ToolUseId
	  }
	| {
			readonly kind: 'review-requested'
			readonly turnId: TurnId
			readonly request: HarnessReviewRequest
			readonly digest: string
	  }
	| {
			readonly kind: 'review-decided'
			readonly turnId: TurnId
			readonly requestId: string
			readonly requestDigest: string
			readonly decisionDigest: string
			readonly decision: HarnessDecision
	  }
	| { readonly kind: 'review-resolved'; readonly turnId: TurnId; readonly requestId: string }
	| { readonly kind: 'connection-lost'; readonly turnId?: TurnId; readonly code: string }
