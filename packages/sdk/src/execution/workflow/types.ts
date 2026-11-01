/**
 * Types of the workflow runtime: a script the model wrote once decides how
 * many subagents run, with which prompts and under which phase titles; the
 * runtime schedules them. See `docs/sdk/workflows.md`.
 */

/** One phase declared in `meta.phases`. */
export interface WorkflowPhaseMeta {
	readonly title: string
	readonly detail?: string
	readonly model?: string
}

/** The pure literal a script exports as `meta`. */
export interface WorkflowMeta {
	readonly name: string
	readonly description: string
	readonly whenToUse?: string
	readonly phases: readonly WorkflowPhaseMeta[]
}

/** What the host is asked to run for one `agent()` call. */
export interface WorkflowAgentRequest {
	/** 1-based, in the order the script asked. */
	readonly index: number
	readonly label: string
	readonly prompt: string
	readonly phaseIndex?: number
	readonly phaseTitle?: string
	/** JSON Schema the result must satisfy; the runtime validates `data`. */
	readonly schema?: Readonly<Record<string, unknown>>
	readonly agentType?: string
	readonly model?: string
	readonly effort?: string
	/** Report live progress; the runtime turns it into `workflow_agent` events. */
	readonly onProgress: (progress: WorkflowAgentProgress) => void
}

export interface WorkflowAgentProgress {
	readonly tokens?: number
	readonly toolCalls?: number
	readonly lastToolName?: string
	readonly lastToolSummary?: string
}

/** What the host's agent run came to. */
export interface WorkflowAgentOutcome {
	readonly state: 'done' | 'error' | 'skipped'
	/** The agent's final text. */
	readonly text?: string
	/** A structured result, when the host produced one for the schema. */
	readonly data?: unknown
	readonly tokens: number
	readonly toolCalls: number
	readonly error?: string
	/** The id of the child session the host ran this agent in, recorded in the journal. */
	readonly sessionId?: string
}

/**
 * Starts one subagent through the host's own delegation path (the same
 * policy, sandbox, accounting and cancellation as the `Agent` tool).
 * Must honour `signal`.
 */
export type WorkflowSpawnAgent = (
	request: WorkflowAgentRequest,
	signal: AbortSignal,
) => Promise<WorkflowAgentOutcome>

export type WorkflowAgentState = 'start' | 'progress' | 'done' | 'error'

export interface WorkflowStartedEvent {
	readonly type: 'workflow_started'
	readonly runId: string
	readonly name: string
	readonly description: string
	readonly phases: readonly WorkflowPhaseMeta[]
	readonly at: number
}

export interface WorkflowPhaseEvent {
	readonly type: 'workflow_phase'
	readonly runId: string
	/** 1-based first-seen order; declared titles come first. */
	readonly index: number
	readonly title: string
	readonly declared: boolean
	readonly at: number
}

/**
 * One agent changed state. `start` without `startedAt` means queued;
 * `start` with `startedAt` means running. A `done` agent that was skipped
 * (by the host, the operator or the token budget) carries `skipped: true`.
 */
export interface WorkflowAgentEvent {
	readonly type: 'workflow_agent'
	readonly runId: string
	readonly state: WorkflowAgentState
	readonly index: number
	readonly label: string
	readonly phaseIndex?: number
	readonly phaseTitle?: string
	readonly agentType?: string
	readonly model?: string
	readonly queuedAt: number
	readonly startedAt?: number
	readonly finishedAt?: number
	readonly lastProgressAt: number
	readonly tokens: number
	readonly toolCalls: number
	readonly lastToolName?: string
	readonly lastToolSummary?: string
	readonly promptPreview: string
	readonly resultPreview?: string
	readonly error?: string
	readonly skipped?: boolean
	/** True when the agent did not run: a resumed run returned the result it saved earlier. */
	readonly cached?: boolean
}

export interface WorkflowLogEvent {
	readonly type: 'workflow_log'
	readonly runId: string
	readonly message: string
	readonly at: number
}

export type WorkflowFinishStatus = 'completed' | 'failed' | 'stopped'

export interface WorkflowUsage {
	/** Agents the script asked for and the runtime accepted. */
	readonly agents: number
	readonly agentsDone: number
	readonly agentsFailed: number
	readonly agentsSkipped: number
	readonly tokens: number
	readonly toolCalls: number
	readonly elapsedMs: number
	/** Agents that returned a result saved by an earlier pass instead of running (a subset of `agentsDone`). */
	readonly cachedAgents?: number
}

export interface WorkflowFinishedEvent {
	readonly type: 'workflow_finished'
	readonly runId: string
	readonly status: WorkflowFinishStatus
	readonly result?: unknown
	readonly error?: string
	readonly usage: WorkflowUsage
	readonly at: number
}

export type WorkflowEvent =
	| WorkflowStartedEvent
	| WorkflowPhaseEvent
	| WorkflowAgentEvent
	| WorkflowLogEvent
	| WorkflowFinishedEvent

export type WorkflowPhaseStatus = 'not-started' | 'running' | 'done' | 'failed'

export interface WorkflowPhaseSummary {
	/** 0 for the derived "Agents" group, which has no phase index. */
	readonly index: number
	readonly title: string
	readonly detail?: string
	readonly status: WorkflowPhaseStatus
	readonly agents: number
	readonly done: number
	readonly failed: number
	readonly tokens: number
}

/** Append-only audit records, one JSON object per line. */
export type WorkflowJournalRecord =
	| {
			readonly type: 'run_started'
			readonly at: number
			readonly runId: string
			readonly scriptSha256: string
			readonly scriptBytes: number
			readonly meta: WorkflowMeta
			readonly args: unknown
			readonly limits: WorkflowResolvedLimits
			/** Present on every pass after the first; a resumed run keeps its run id and journal. */
			readonly resume?: {
				readonly pass: number
				readonly previousFinish: WorkflowFinishStatus | 'unfinished'
				readonly scriptSha256Changed: boolean
			}
			/** Where the script came from when the host read it from a file. */
			readonly scriptPath?: string
	  }
	| {
			readonly type: 'phase'
			readonly at: number
			readonly index: number
			readonly title: string
			readonly declared: boolean
	  }
	| {
			readonly type: 'agent_request'
			readonly at: number
			readonly index: number
			readonly label: string
			readonly phaseIndex?: number
			readonly phaseTitle?: string
			readonly promptPreview: string
			readonly promptSha256: string
			readonly options: {
				readonly agentType?: string
				readonly model?: string
				readonly effort?: string
				readonly schema: boolean
			}
			/** Identifies the call across passes; see `workflowCallKey`. */
			readonly key?: string
			/** 1 for the first pass. A record from an older pass than the latest `run_started` is stale. */
			readonly pass?: number
			/** The agent did not run; its result came from an earlier pass. */
			readonly cached?: true
	  }
	| {
			readonly type: 'agent_outcome'
			readonly at: number
			readonly index: number
			readonly state: 'done' | 'error' | 'skipped'
			readonly tokens: number
			readonly toolCalls: number
			readonly queuedAt: number
			readonly startedAt?: number
			readonly finishedAt: number
			readonly resultPreview?: string
			readonly error?: string
			readonly key?: string
			readonly pass?: number
			readonly cached?: true
			/** The agent's full value (after schema validation); present only for a finished, non-null result. */
			readonly result?: unknown
			/** A value existed but could not be saved; a resume runs this agent again. */
			readonly unsaved?: true
			/** The run or the agent was stopped before the agent finished; a resume runs it again and keeps its saved results valid. */
			readonly interrupted?: true
			/** Where a cached result was first recorded. */
			readonly resultFrom?: { readonly pass: number; readonly index: number }
			readonly childSessionId?: string
	  }
	| { readonly type: 'log'; readonly at: number; readonly message: string }
	| {
			readonly type: 'run_finished'
			readonly at: number
			readonly status: WorkflowFinishStatus
			readonly result?: unknown
			readonly error?: string
			readonly usage: WorkflowUsage
			/** Written by a later session for a run whose process ended without finishing it. */
			readonly recovered?: true
	  }

/** Where a run's audit trail goes. Injected so the SDK stays host-agnostic. */
export interface WorkflowJournal {
	/** Called once, before the first record, with the exact script text. */
	writeScript?(source: string, sha256: string, pass?: number): Promise<void> | void
	append(record: WorkflowJournalRecord): Promise<void> | void
}

export interface WorkflowLimits {
	/** Agents running at once. Default `min(16, cpus - 2)`, at least 2; at most 16. */
	readonly maxConcurrency?: number
	/** Agents one run may start. Default 1000; at most 1000. */
	readonly maxAgents?: number
	/** UTF-8 script size. Default 256 KiB. */
	readonly maxSourceBytes?: number
	/** Interpreter memory. Default 64 MiB. */
	readonly memoryLimitBytes?: number
	/** One value crossing the bridge, either way. Default 1 MiB. */
	readonly maxValueBytes?: number
	/** Stop admitting new agents once this many tokens are spent; also the script's `budget.total`. Default: none. */
	readonly tokenBudget?: number
	/** Wall clock for the whole run. Default 6 hours. */
	readonly maxDurationMs?: number
	/** One synchronous stretch of script execution. Default 2 seconds. */
	readonly cpuSliceMs?: number
	/** All synchronous script execution together. Default 60 seconds. */
	readonly cpuTotalMs?: number
}

export interface WorkflowResolvedLimits {
	readonly maxConcurrency: number
	readonly maxAgents: number
	readonly maxSourceBytes: number
	readonly memoryLimitBytes: number
	readonly maxValueBytes: number
	readonly tokenBudget?: number
	readonly maxDurationMs: number
	readonly cpuSliceMs: number
	readonly cpuTotalMs: number
}

/** Lets the host act on one running agent. Handed to `onControl`. */
export interface WorkflowControl {
	/** Skip an agent: queued ones never start, running ones are aborted. Its `agent()` resolves `null`. */
	skipAgent(index: number): boolean
}

export interface WorkflowRunOptions {
	/** The script, including its `export const meta` literal. Untrusted. */
	readonly script: string
	/** JSON handed to the script as `args`. */
	readonly args?: unknown
	readonly limits?: WorkflowLimits
	readonly spawnAgent: WorkflowSpawnAgent
	readonly journal?: WorkflowJournal
	readonly signal?: AbortSignal
	readonly onEvent?: (event: WorkflowEvent) => void
	readonly onControl?: (control: WorkflowControl) => void
	/** Default: a fresh `w` + 8 base36 id. */
	readonly runId?: string
	/**
	 * Continue an earlier run: agents whose prompt and options are unchanged
	 * return the result saved in the journal instead of running. Build it with
	 * `loadWorkflowResume`, and pass the same `runId`.
	 */
	readonly resume?: WorkflowResumeState
	/**
	 * Make the script repeatable, which resuming needs: `Date.now()`,
	 * `new Date()` with no argument and `Math.random()` throw, and `eval` is
	 * removed. Default false.
	 */
	readonly deterministic?: boolean
	/** Say in a failure that the run can be resumed. Default false. */
	readonly canResume?: boolean
	/** Recorded in `run_started` when the host read the script from a file. */
	readonly scriptPath?: string
}

/** Everything a resumed pass needs from the earlier passes of one run. */
export interface WorkflowResumeState {
	/** The number of the pass about to run (2 for the first resume). */
	readonly pass: number
	readonly results: ReadonlyMap<
		string,
		{
			readonly value: unknown
			readonly pass: number
			readonly index: number
			readonly childSessionId?: string
		}
	>
	/** Keys the earlier passes asked for, finished or not. */
	readonly seen: ReadonlySet<string>
	/** Keys whose last outcome was a failure or a skip. */
	readonly failed: ReadonlySet<string>
	/** Keys that were asked for again after a result was saved and never finished since. */
	readonly demoted: ReadonlySet<string>
	readonly scriptSha256?: string
	readonly previousFinish: WorkflowFinishStatus | 'unfinished'
	/** Plain-language findings about the journal (changed, cut short, saved before resuming existed). */
	readonly problems: readonly string[]
	readonly resumable: boolean
	/** First line (1-based) the integrity check could not trust, when any. */
	readonly brokenAt?: number
}

/** A journal that can be read back, with its integrity checked. */
export interface WorkflowJournalReader {
	read(): Promise<CheckedWorkflowJournal>
}

/** A journal record as written by `FileWorkflowJournal`: numbered and chained to the line before it. */
export type ChainedWorkflowJournalRecord = WorkflowJournalRecord & {
	readonly seq: number
	readonly prev: string
}

/** What reading a journal found. Only `records` can be trusted. */
export interface CheckedWorkflowJournal {
	/** Records that passed the integrity check, in order. */
	readonly records: readonly ChainedWorkflowJournalRecord[]
	/** The journal was written before records were chained; it can be shown but not resumed. */
	readonly legacy: boolean
	/** The last write was cut off mid-line and was ignored. */
	readonly tornTail: boolean
	/** First line (1-based) that failed the check, when lines were changed, removed or cut short. */
	readonly brokenAt?: number
	/** Sequence number and hash the next record must chain from. */
	readonly lastSeq: number
	readonly lastHash: string
	/** The file ends in a newline (false after a torn write). */
	readonly endsWithNewline: boolean
	/** Records of a legacy journal, for display only. */
	readonly untrusted: readonly WorkflowJournalRecord[]
}

export interface WorkflowRunResult {
	readonly runId: string
	readonly status: WorkflowFinishStatus
	/** What the script returned (`completed` only). */
	readonly result?: unknown
	readonly error?: string
	readonly usage: WorkflowUsage
	readonly phases: readonly WorkflowPhaseSummary[]
	/** True when the script logged more than the output cap and later lines were dropped. */
	readonly logsTruncated: boolean
	/** Set when the journal could not be written; the run itself was not affected. */
	readonly journalError?: string
}
