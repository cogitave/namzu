import { type RunEvent, type TaskHandle, genericLabel, isTerminalAgentTaskState } from '@namzu/sdk'

const MAX_RETAINED_AGENTS = 80
const MAX_TRANSCRIPT_ROWS = 120
const MAX_ROW_CODE_UNITS = 2_048
const MAX_PROMPT_CODE_UNITS = 4_096
export const MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS = 240
export const MAX_AGENT_PHASE_ORDER = 10_000
const MAX_IDENTITY_LABEL_CODE_UNITS = 4_096
const NOTIFY_INTERVAL_MS = 100
/**
 * Longest narration line kept. One line of commentary, not a message: a
 * parent that writes a paragraph gets it clipped with the same marker every
 * other retained label here carries.
 */
export const MAX_NARRATION_CODE_UNITS = 200
/**
 * Narration lines retained at once, oldest dropped first.
 *
 * Small deliberately. The lines render in the most valuable rows on the
 * screen — between the composer footer and the agent rail — so a parent that
 * keeps talking must cost the operator a FIXED number of rows rather than a
 * growing one. Raising this trades conversation for commentary.
 */
export const MAX_RETAINED_NARRATION = 3

/**
 * Appended to a replayed transcript whose saved records could not all be
 * read, so a short transcript is never mistaken for a short run. Said in the
 * transcript itself rather than only in a header, because the rows are what
 * an operator reads as the whole of what happened.
 */
export const PARTIAL_EVIDENCE_NOTICE =
	'Saved transcript is damaged or truncated; this replay shows only the records that could be read.'

export const DEFAULT_AGENT_WORKFLOW = 'Delegated work'
export const DEFAULT_AGENT_PHASE = 'Work'

export type SubagentActivityStatus =
	| 'starting'
	| 'queued'
	| 'working'
	| 'completed'
	| 'failed'
	| 'cancelled'

/**
 * Only value produced today: a correction or context queued with
 * `send_message`, delivered into a running child. Named for the receiving
 * surface's point of view — the child received it — so the glyph each
 * renderer picks stays unambiguous without re-reading the row's text.
 */
export type SubagentMessageDirection = 'to-child'

export type SubagentTranscriptRow =
	| {
			readonly id: string
			readonly kind: 'assistant'
			readonly text: string
	  }
	| {
			readonly id: string
			readonly kind: 'tool'
			readonly text: string
			readonly status: 'working' | 'completed' | 'failed'
			readonly detail?: string
	  }
	| {
			readonly id: string
			readonly kind: 'system'
			readonly text: string
			/**
			 * Set only for a delivered `send_message`; absent for every other
			 * system row (agent_failed, run_failed, the settle fallback), which
			 * render as before.
			 */
			readonly direction?: SubagentMessageDirection
	  }

export interface SubagentActivity {
	/** Stable for this screen even before the scheduler returns a task id. */
	readonly viewId: string
	readonly taskId?: string
	readonly runId?: string
	readonly agentId: string
	/** The resolved child model, when a host supplied one at launch. */
	readonly model?: string
	/**
	 * Cumulative spend from the child's latest `token_usage_updated` event —
	 * never `contextTokens`, which shrinks on compaction and answers a
	 * different question. Absent means this child has not reported usage
	 * yet, which is a distinct fact from having spent zero.
	 */
	readonly tokens?: number
	/** Tool executions started so far, counted once per execution. */
	readonly toolCalls?: number
	readonly description: string
	readonly prompt: string
	/** Direct tool batch that launched this concurrent sibling cohort. */
	readonly batchId: string
	/** Exact parent Agent tool call, used to suppress only its generic row. */
	readonly toolUseId?: string
	/** Parent run identity; display labels never serve as orchestration identity. */
	readonly workflowId: string
	/** Display group scoped to a parent run and explicit workflow, or an unlabelled batch. */
	readonly workflowGroupId: string
	/** Monitor-owned phase identity, stable even when display labels collide. */
	readonly phaseId: string
	readonly workflow: string
	readonly phase: string
	readonly phaseOrder?: number
	/** Detail text the first agent to declare this phase supplied; later siblings never change it. */
	readonly phaseDetail?: string
	readonly phaseSequence: number
	readonly status: SubagentActivityStatus
	readonly startedAt: number
	readonly completedAt?: number
	readonly latestActivity?: string
	readonly transcript: readonly SubagentTranscriptRow[]
	/**
	 * This row was rebuilt from evidence a finished child left on disk, not
	 * projected from a child running in this process.
	 *
	 * Absent means live. It is on the record rather than inferred from
	 * `status` because the two answer different questions: a terminal status
	 * says the work ended, while this says nothing is attached to it any
	 * more — no task id the scheduler still knows, no stream, nothing a
	 * message or a cancellation could reach. Every surface that offers to act
	 * on a child reads this first, and the transcript says so on screen.
	 */
	readonly replayed?: boolean
}

/**
 * One line of commentary the PARENT wrote about the work it is coordinating.
 *
 * Parent-authored is the whole design, not an implementation detail. A line a
 * child emitted and this host rendered as the run's own voice would be
 * untrusted text presented as trusted narration — the injection shape the
 * coordinator's untrusted-output wrapping exists to prevent. Nothing here
 * takes a line from a child: the tool that writes these is registered on the
 * parent's registry only, exactly like `send_message`, and a child's roster is
 * built from the host's own `buildTools()` which never carries it. If child
 * narration is ever wanted it goes through that same wrapping and is
 * attributed to the child by name.
 *
 * Commentary carries no status meaning. Nothing reads it back, no surface
 * derives state from it, and a run with none looks exactly as it did before
 * this existed.
 */
export interface SubagentNarrationLine {
	/** Stable key for a renderer; unique for the life of this monitor. */
	readonly id: string
	readonly text: string
	readonly at: number
}

/**
 * What {@link SubagentActivityMonitor.narrate} did with a line.
 *
 * Three cases rather than a line-or-nothing answer, because the two ways
 * nothing is kept are not the same thing to whoever wrote the line: `empty`
 * is a line with nothing in it, which the writer can fix by writing another
 * one, and `closed` is a monitor that has stopped showing anything at all,
 * which no further line will reach. Reporting the second as the first tells
 * the writer to correct text that was never the problem.
 */
export type SubagentNarrationOutcome =
	| { readonly kind: 'shown'; readonly line: SubagentNarrationLine }
	| { readonly kind: 'empty' }
	| { readonly kind: 'closed' }

/** Read-only side of the current CLI session's child-run monitor. */
export interface SubagentActivitySource {
	getSnapshot(): readonly SubagentActivity[]
	subscribe(listener: () => void): () => void
	/** Start a new conversation scope; late events from the old one are ignored. */
	reset(): void
	/**
	 * Bounded parent-authored commentary, oldest first.
	 *
	 * Optional because this is an ADDITIONAL projection over the same monitor,
	 * not part of what makes a source one: a host that publishes child rows and
	 * writes no commentary is complete without it, and absent reads as "no
	 * narration" at every call site.
	 */
	getNarration?(): readonly SubagentNarrationLine[]
}

/**
 * The display grouping one delegation carries. Supplied at `begin()` and
 * again on the child's `agent_pending` event, which is the copy that leaves
 * this process; both name the same thing, and the monitor keeps the `begin()`
 * values as the seed so a child that fails before the event ever arrives still
 * groups where the operator saw it launch.
 *
 * Display-only, exactly as the `Agent` tool's schema says: these create no
 * dependencies, barriers or serial execution. Phase IDENTITY stays
 * monitor-owned (`phaseId`) and is never one of these labels.
 */
export interface SubagentDisplayLabels {
	readonly workflow?: string
	readonly phase?: string
	readonly phaseOrder?: number
	readonly phaseDetail?: string
}

/** What a host knows about a child at launch, before any event has arrived. */
export interface BeginSubagentInput {
	readonly agentId: string
	readonly model?: string
	readonly description: string
	readonly prompt: string
	readonly batchId?: string
	readonly toolUseId?: string
	readonly workflowId?: string
	readonly workflow?: string
	readonly phase?: string
	readonly phaseOrder?: number
	readonly phaseDetail?: string
}

/**
 * What a child's saved `run.json` supplies to
 * {@link SubagentActivityMonitor.replay}, beside its transcript.
 *
 * Every field except `agentId` and `description` is optional, because
 * `run.json` is written on a run's terminal path: a child killed before it
 * got there leaves a transcript worth opening and a record that never
 * recorded an ending. Absent is "the file did not say", and the projection
 * keeps whatever the events established rather than substituting a zero.
 */
export interface ReplaySubagentInput {
	readonly agentId: string
	readonly model?: string
	readonly description: string
	/**
	 * The child's instructions, when the caller has them.
	 *
	 * Defaults to empty rather than to invented text. A child's prompt is in
	 * its message snapshot, not in its durable event log, and reading a whole
	 * `messages.json` to recover one line is a cost this view does not pay.
	 */
	readonly prompt?: string
	readonly runId?: string
	readonly batchId?: string
	readonly workflowId?: string
	readonly status?: SubagentActivityStatus
	readonly tokens?: number
	readonly startedAt?: number
	readonly completedAt?: number
	/** Some records in the saved transcript could not be read. */
	readonly partial?: boolean
}

export interface SubagentActivityTracker {
	readonly onEvent: (event: RunEvent) => void
	settle(handle: TaskHandle): void
	fail(error: unknown): void
}

interface MutableActivity {
	readonly epoch: number
	readonly order: number
	readonly viewId: string
	taskId?: string
	runId?: string
	agentId: string
	model?: string
	tokens?: number
	toolCalls?: number
	description: string
	prompt: string
	batchId: string
	toolUseId?: string
	workflowId: string
	workflowGroupId: string
	phaseId: string
	workflow: string
	phase: string
	phaseOrder?: number
	phaseDetail?: string
	phaseSequence: number
	/** Labels this record is currently grouped by; the seed for a later event. */
	labels: SubagentDisplayLabels
	status: SubagentActivityStatus
	startedAt: number
	completedAt?: number
	latestActivity?: string
	rows: SubagentTranscriptRow[]
	closed: boolean
}

/**
 * Projects each child stream immediately and retains only bounded display
 * state. Raw RunEvents never accumulate here: images, tool inputs and token
 * deltas can be arbitrarily large and the parent TUI must not inherit them.
 */
export class SubagentActivityMonitor implements SubagentActivitySource {
	private readonly records = new Map<string, MutableActivity>()
	private readonly listeners = new Set<() => void>()
	/** Bounded parent commentary, oldest first. See {@link SubagentNarrationLine}. */
	private readonly narration: SubagentNarrationLine[] = []
	private narrationCounter = 0
	private epoch = 0
	private counter = 0
	private fallbackBatchCounter = 0
	private phaseCounter = 0
	private messageCounter = 0
	private readonly phases = new Map<
		string,
		{
			readonly id: string
			readonly order?: number
			readonly detail?: string
			readonly sequence: number
		}
	>()
	private notifyTimer: ReturnType<typeof setTimeout> | undefined
	private closed = false

	/**
	 * `replay: true` seeds this monitor from saved evidence instead of a live
	 * child stream. Two things change and nothing else: notifications stop
	 * coalescing on a timer (there is no stream to coalesce, and a replay
	 * monitor is read once by whoever built it), and every row it publishes is
	 * marked {@link SubagentActivity.replayed}. The projection, the grouping
	 * and every bound are the ones the live path uses.
	 */
	constructor(private readonly options: { readonly replay?: boolean } = {}) {}

	begin(input: BeginSubagentInput): SubagentActivityTracker {
		return this.open(input).tracker
	}

	/**
	 * `begin()`, plus the record it opened.
	 *
	 * Split out for {@link SubagentActivityMonitor.replay}, which has to reach
	 * the record after the events are in to write the facts `run.json` holds
	 * and the transcript does not. Nothing else needs it, and nothing outside
	 * this class gets it: a caller holding a `MutableActivity` could edit
	 * around every bound this file enforces.
	 */
	private open(
		input: BeginSubagentInput,
		suppliedViewId?: string,
	): {
		readonly record: MutableActivity
		readonly tracker: SubagentActivityTracker
	} {
		const epoch = this.epoch
		const order = ++this.counter
		// A replay allocates its own monitor, so its counter starts at one
		// beside a live monitor's. An `agent-1` from each would be two
		// different children answering to one id, and every surface here looks
		// a child up by this string. `replay()` supplies an id derived from the
		// child's run instead: unique against the live path by construction,
		// and identical across re-reads, so re-opening the cockpit does not
		// move the operator's selection off the row they were reading.
		const viewId = suppliedViewId ?? `agent-${order}`
		const workflowId = normalizedLabel(input.workflowId, 'session', MAX_IDENTITY_LABEL_CODE_UNITS)
		const requestedBatchId = input.batchId?.trim()
		const batchId = requestedBatchId
			? bounded(requestedBatchId, MAX_IDENTITY_LABEL_CODE_UNITS)
			: this.fallbackBatchId(workflowId)
		const labels = displayLabels(input)
		const grouping = this.group(workflowId, batchId, labels)
		const record: MutableActivity = {
			epoch,
			order,
			viewId,
			agentId: bounded(input.agentId, MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS),
			...(input.model?.trim()
				? { model: bounded(input.model.trim(), MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS) }
				: {}),
			description: bounded(input.description, MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS),
			prompt: bounded(input.prompt, MAX_PROMPT_CODE_UNITS),
			batchId,
			...(input.toolUseId
				? { toolUseId: bounded(input.toolUseId, MAX_IDENTITY_LABEL_CODE_UNITS) }
				: {}),
			workflowId,
			...grouping,
			labels,
			status: 'starting',
			startedAt: Date.now(),
			rows: [],
			closed: false,
		}
		this.records.set(viewId, record)
		this.prune()
		this.notifyNow()

		const current = (): MutableActivity | undefined => {
			if (this.closed || epoch !== this.epoch || record.closed) return undefined
			return this.records.get(viewId) === record ? record : undefined
		}
		const tracker: SubagentActivityTracker = {
			onEvent: (event) => {
				const owned = current()
				if (!owned) return
				if (event.type === 'agent_pending') this.relabel(owned, event)
				projectEvent(owned, event)
				this.scheduleNotify()
			},
			settle: (handle) => {
				const owned = current()
				if (!owned) return
				owned.taskId = String(handle.taskId)
				owned.agentId = bounded(handle.agentId, MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS)
				owned.status = statusOf(handle)
				if (!isTerminal(owned.status)) {
					owned.latestActivity = terminalLabel(owned.status)
					this.notifyNow()
					return
				}
				owned.completedAt = handle.completedAt ?? Date.now()
				owned.latestActivity =
					handle.result?.stopReason && handle.result.stopReason !== 'end_turn'
						? `Stopped · ${handle.result.stopReason}`
						: terminalLabel(owned.status)
				if (owned.rows.length === 0) {
					pushRow(owned, {
						id: `${owned.viewId}:unavailable`,
						kind: 'system',
						text: 'Live transcript was not exposed by this scheduler; the settled result remains on the parent Agent call.',
					})
				}
				owned.closed = true
				this.prune()
				this.notifyNow()
			},
			fail: (error) => {
				const owned = current()
				if (!owned) return
				const cancelled = cancellationLike(error)
				owned.status = cancelled ? 'cancelled' : 'failed'
				owned.completedAt = Date.now()
				owned.latestActivity = terminalLabel(owned.status)
				pushRow(owned, {
					id: `${owned.viewId}:failure`,
					kind: 'system',
					text: bounded(errorMessage(error), MAX_ROW_CODE_UNITS),
				})
				owned.closed = true
				this.prune()
				this.notifyNow()
			},
		}
		return { record, tracker }
	}

	/**
	 * Rebuilds one finished child from the evidence it left on disk, and
	 * retains it here like any other row.
	 *
	 * The load-bearing line is the `tracker.onEvent` loop: saved events go
	 * through the SAME entry point a live child's events do, so the cockpit
	 * cannot drift from a replay. There is no second projection to keep in
	 * step, and a field added to the live path appears here for free.
	 *
	 * What the events cannot supply, the caller passes from `run.json`, and it
	 * is written AFTER the loop because the file is the authority on the two
	 * facts a child's own transcript never records: a child's delegation
	 * outcome and its final totals are reported on the PARENT's event stream,
	 * which does not enter the child's log. Without this the replay would end
	 * on whatever the last durable event said and show a finished child as
	 * still working.
	 *
	 * Only meaningful on a monitor constructed with `replay: true`; on a live
	 * one it would publish a saved row as though a child were attached to it.
	 */
	replay(input: ReplaySubagentInput, events: Iterable<RunEvent>): SubagentActivity {
		const { record, tracker } = this.open(
			{
				agentId: input.agentId,
				...(input.model ? { model: input.model } : {}),
				description: input.description,
				prompt: input.prompt ?? '',
				...(input.batchId ? { batchId: input.batchId } : {}),
				...(input.workflowId ? { workflowId: input.workflowId } : {}),
			},
			input.runId ? bounded(`saved-${input.runId}`, MAX_IDENTITY_LABEL_CODE_UNITS) : undefined,
		)
		for (const event of events) tracker.onEvent(event)
		if (!record.runId && input.runId) {
			record.runId = bounded(input.runId, MAX_IDENTITY_LABEL_CODE_UNITS)
		}
		if (input.tokens !== undefined) record.tokens = input.tokens
		if (input.status) record.status = input.status
		if (input.startedAt !== undefined) record.startedAt = input.startedAt
		if (input.completedAt !== undefined) record.completedAt = input.completedAt
		// The same label `settle()` writes for a live child, for the same
		// reason: the last streamed activity line describes a moment that is
		// over, and leaving it up reads as a child still doing that thing.
		if (isTerminal(record.status)) record.latestActivity = terminalLabel(record.status)
		if (input.partial) {
			pushRow(record, {
				id: `${record.viewId}:partial`,
				kind: 'system',
				text: PARTIAL_EVIDENCE_NOTICE,
			})
		}
		record.closed = true
		this.prune()
		return this.project(record)
	}

	/**
	 * Pushes a bounded system row recording a message delivered into a
	 * running child, through the same `pushRow` path every other transcript
	 * row uses. Callers own delivery: this only records that it happened, so
	 * it must run after the send it announces has actually succeeded — a
	 * refused or unowned send must never call this. A `taskId` with no
	 * matching record (already pruned, or never tracked) is a silent no-op:
	 * there is no row left to explain what was sent.
	 */
	recordMessage(taskId: string, text: string, direction: SubagentMessageDirection): void {
		if (this.closed) return
		const record = [...this.records.values()].find((entry) => entry.taskId === taskId)
		if (!record) return
		pushRow(record, {
			id: `${record.viewId}:message:${++this.messageCounter}`,
			kind: 'system',
			text: bounded(text, MAX_ROW_CODE_UNITS),
			direction,
		})
		this.notifyNow()
	}

	/**
	 * Retains one line of PARENT-authored commentary for the rail to show.
	 *
	 * Callers are the parent's own tool call and nothing else — see
	 * {@link SubagentNarrationLine} for why that boundary is the design rather
	 * than a detail. Blank or control-only text is dropped instead of retained,
	 * so a row is never spent on a line with nothing in it, and the answer
	 * names which of the two things happened — see
	 * {@link SubagentNarrationOutcome}.
	 *
	 * Independent of the child records: narration is commentary, so it neither
	 * needs a child to attach to nor disappears when the last one settles —
	 * which is exactly when a line explaining what happens next is worth most.
	 */
	narrate(text: string): SubagentNarrationOutcome {
		if (this.closed) return { kind: 'closed' }
		const line = normalizedLabel(text, '', MAX_NARRATION_CODE_UNITS)
		if (!line) return { kind: 'empty' }
		const entry: SubagentNarrationLine = Object.freeze({
			id: `narration-${++this.narrationCounter}`,
			text: line,
			at: Date.now(),
		})
		this.narration.push(entry)
		if (this.narration.length > MAX_RETAINED_NARRATION)
			this.narration.splice(0, this.narration.length - MAX_RETAINED_NARRATION)
		this.notifyNow()
		return { kind: 'shown', line: entry }
	}

	getNarration(): readonly SubagentNarrationLine[] {
		return [...this.narration]
	}

	getSnapshot(): readonly SubagentActivity[] {
		return [...this.records.values()]
			.sort((left, right) => {
				const live = Number(isTerminal(left.status)) - Number(isTerminal(right.status))
				return live !== 0 ? live : left.order - right.order
			})
			.map((record) => this.project(record))
	}

	/** One record as the frozen, bounded shape every surface reads. */
	private project(record: MutableActivity): SubagentActivity {
		return Object.freeze({
			viewId: record.viewId,
			...(record.taskId ? { taskId: record.taskId } : {}),
			...(record.runId ? { runId: record.runId } : {}),
			agentId: record.agentId,
			...(record.model ? { model: record.model } : {}),
			...(record.tokens !== undefined ? { tokens: record.tokens } : {}),
			...(record.toolCalls !== undefined ? { toolCalls: record.toolCalls } : {}),
			description: record.description,
			prompt: record.prompt,
			batchId: record.batchId,
			...(record.toolUseId ? { toolUseId: record.toolUseId } : {}),
			workflowId: record.workflowId,
			workflowGroupId: record.workflowGroupId,
			phaseId: record.phaseId,
			workflow: record.workflow,
			phase: record.phase,
			...(record.phaseOrder !== undefined ? { phaseOrder: record.phaseOrder } : {}),
			...(record.phaseDetail !== undefined ? { phaseDetail: record.phaseDetail } : {}),
			phaseSequence: record.phaseSequence,
			status: record.status,
			...(this.options.replay ? { replayed: true } : {}),
			startedAt: record.startedAt,
			...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
			...(record.latestActivity ? { latestActivity: record.latestActivity } : {}),
			transcript: Object.freeze(record.rows.map((row) => Object.freeze({ ...row }))),
		})
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	reset(): void {
		this.epoch += 1
		this.records.clear()
		this.phases.clear()
		this.phaseCounter = 0
		// Commentary belongs to the conversation it was written in, like every
		// other buffer here. The counter is NOT rewound: ids stay unique across
		// scopes, so a renderer holding a stale key never matches a new line.
		this.narration.length = 0
		this.clearNotifyTimer()
		this.notifyNow()
	}

	close(): void {
		if (this.closed) return
		this.closed = true
		this.records.clear()
		this.phases.clear()
		this.narration.length = 0
		this.clearNotifyTimer()
		this.notifyNow()
		this.listeners.clear()
	}

	/**
	 * Resolves display labels to this monitor's grouping identities.
	 *
	 * Phase identity is allocated here and only here, first-writer-wins per
	 * `[workflowGroupId, phase]`: the first agent to name a phase fixes its
	 * id, its display order and its detail text, and a later sibling that
	 * disagrees joins the phase rather than changing it. That is what keeps a
	 * pane from flickering between two wordings of the same stage, and it is
	 * also why calling this twice for one agent with the same labels is
	 * exactly a no-op — the second call finds the definition the first made.
	 *
	 * Definitions live for the conversation: `reset()` and `dispose()` clear
	 * them and nothing prunes them in between, so the map holds one entry per
	 * distinct `[workflowGroupId, phase]` anything has named. A host that
	 * labels one child differently at `begin()` and on its event defines two of
	 * them; the size follows how many wordings a host invents, not how long the
	 * session runs.
	 */
	private group(
		workflowId: string,
		batchId: string,
		labels: SubagentDisplayLabels,
	): {
		workflowGroupId: string
		phaseId: string
		workflow: string
		phase: string
		phaseOrder?: number
		phaseDetail?: string
		phaseSequence: number
	} {
		const workflowIdentity = normalizedLabel(
			labels.workflow,
			DEFAULT_AGENT_WORKFLOW,
			MAX_IDENTITY_LABEL_CODE_UNITS,
		)
		const phaseIdentity = normalizedLabel(
			labels.phase,
			DEFAULT_AGENT_PHASE,
			MAX_IDENTITY_LABEL_CODE_UNITS,
		)
		// A tool batch is a concurrency boundary, not a workflow phase. Explicit
		// workflow annotations may span several batches within their parent run;
		// unrelated unlabelled batches have no evidence of a shared workflow.
		const workflowGroupId = JSON.stringify(
			labels.workflow?.trim()
				? [workflowId, 'workflow', workflowIdentity]
				: [workflowId, 'batch', batchId],
		)
		const phaseKey = JSON.stringify([workflowGroupId, phaseIdentity])
		let phaseDefinition = this.phases.get(phaseKey)
		if (!phaseDefinition) {
			const sequence = ++this.phaseCounter
			const order = normalizedPhaseOrder(labels.phaseOrder)
			// Reuses normalizedLabel's own trim/control-strip/bound pipeline with an
			// empty fallback, so an absent or blank detail collapses to `undefined`
			// rather than a visible placeholder.
			const detail =
				normalizedLabel(labels.phaseDetail, '', MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS) || undefined
			phaseDefinition = {
				// Namespaced for the same reason `viewId` is: phases are grouped by
				// this id ALONE, so a replay monitor's `phase-1` and a live one's
				// would fold two unrelated phases into one row on screen.
				id: `${this.options.replay ? 'saved-phase' : 'phase'}-${sequence}`,
				...(order !== undefined ? { order } : {}),
				...(detail !== undefined ? { detail } : {}),
				sequence,
			}
			this.phases.set(phaseKey, phaseDefinition)
		}
		return {
			workflowGroupId,
			phaseId: phaseDefinition.id,
			workflow: bounded(workflowIdentity, MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS),
			phase: bounded(phaseIdentity, MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS),
			...(phaseDefinition.order !== undefined ? { phaseOrder: phaseDefinition.order } : {}),
			...(phaseDefinition.detail !== undefined ? { phaseDetail: phaseDefinition.detail } : {}),
			phaseSequence: phaseDefinition.sequence,
		}
	}

	/**
	 * Re-reads the grouping from the labels the child's own `agent_pending`
	 * carried.
	 *
	 * The event is the copy that leaves this process, so a host that supplies
	 * labels there and nowhere else still gets grouped. The `begin()` values
	 * stay the seed and are merged under the event's, which is what keeps an
	 * agent that fails before `agent_pending`
	 * ever arrives grouped where the operator saw it launch, and what stops a
	 * partially labelled event from erasing a label it never mentioned.
	 *
	 * An event naming none of the four changes nothing at all: the common case
	 * is the same labels arriving twice, where `group()` returns the definition
	 * `begin()` already made and every field is rewritten to the value it
	 * already held.
	 */
	private relabel(record: MutableActivity, labels: SubagentDisplayLabels): void {
		const supplied = displayLabels(labels)
		if (Object.keys(supplied).length === 0) return
		const merged: SubagentDisplayLabels = { ...record.labels, ...supplied }
		const grouping = this.group(record.workflowId, record.batchId, merged)
		record.workflowGroupId = grouping.workflowGroupId
		record.phaseId = grouping.phaseId
		record.workflow = grouping.workflow
		record.phase = grouping.phase
		record.phaseOrder = grouping.phaseOrder
		record.phaseDetail = grouping.phaseDetail
		record.phaseSequence = grouping.phaseSequence
		record.labels = merged
	}

	private fallbackBatchId(workflowId: string): string {
		for (const record of this.records.values()) {
			if (record.workflowId === workflowId && !isTerminal(record.status)) return record.batchId
		}
		return `batch-${++this.fallbackBatchCounter}`
	}

	private prune(): void {
		const terminal = [...this.records.values()]
			.filter((record) => isTerminal(record.status))
			.sort((left, right) => left.order - right.order)
		while (terminal.length > MAX_RETAINED_AGENTS) {
			const oldest = terminal.shift()
			if (oldest) this.records.delete(oldest.viewId)
		}
	}

	private scheduleNotify(): void {
		if (this.options.replay) return
		if (this.closed || this.notifyTimer) return
		this.notifyTimer = setTimeout(() => {
			this.notifyTimer = undefined
			this.notifyNow()
		}, NOTIFY_INTERVAL_MS)
		this.notifyTimer.unref?.()
	}

	private clearNotifyTimer(): void {
		if (!this.notifyTimer) return
		clearTimeout(this.notifyTimer)
		this.notifyTimer = undefined
	}

	private notifyNow(): void {
		if (this.notifyTimer) this.clearNotifyTimer()
		for (const listener of this.listeners) {
			try {
				listener()
			} catch {
				// Observers are projections, never backpressure or authority. One
				// broken renderer must not keep other surfaces from receiving state.
			}
		}
	}
}

/**
 * The display labels present on an input, with absent ones left out rather
 * than carried as `undefined` keys — the merge in `relabel` is a spread, and
 * an explicit `undefined` there would erase a seeded label instead of leaving
 * it alone. Present-but-empty is kept: `''` and absent are different answers,
 * and only the caller's own `!== undefined` test can tell them apart. No event
 * this repo emits can carry `''` — the agent manager, the scheduler and the SSE
 * transform each drop an empty label by truthiness, the same way they treat
 * `planId` — so that distinction answers a host that builds the event itself.
 *
 * Bounded because the result is RETAINED as a record's seed, and one source of
 * these is now an event rather than this process's own tool call. The bound is
 * the identity ceiling `group()` already truncates at, not the narrower display
 * cap: `group()` derives phase identity from these through `normalizedLabel`,
 * so clipping shorter here would change which phase a long label lands in on
 * the `begin()` path too, and that grouping must not move. Nothing the `Agent`
 * tool can produce reaches either ceiling — its schema caps the three strings
 * at `MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS` — so this is a bound on what an
 * arbitrary host may make this monitor hold, not a clip on a real label.
 */
function displayLabels(input: SubagentDisplayLabels): SubagentDisplayLabels {
	return {
		...(input.workflow !== undefined
			? { workflow: bounded(input.workflow, MAX_IDENTITY_LABEL_CODE_UNITS) }
			: {}),
		...(input.phase !== undefined
			? { phase: bounded(input.phase, MAX_IDENTITY_LABEL_CODE_UNITS) }
			: {}),
		...(input.phaseOrder !== undefined ? { phaseOrder: input.phaseOrder } : {}),
		...(input.phaseDetail !== undefined
			? { phaseDetail: bounded(input.phaseDetail, MAX_IDENTITY_LABEL_CODE_UNITS) }
			: {}),
	}
}

function projectEvent(record: MutableActivity, event: RunEvent): void {
	switch (event.type) {
		case 'agent_pending':
			record.taskId = String(event.taskId)
			record.agentId = bounded(event.childAgentId, MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS)
			record.status = 'queued'
			record.latestActivity = 'Queued'
			return
		case 'run_started':
			record.runId = String(event.runId)
			record.status = 'working'
			record.latestActivity = 'Working'
			return
		case 'token_usage_updated':
			// `usage` is cumulative spend across the run; `contextTokens` beside
			// it is the current conversation size and shrinks on compaction —
			// a different question this row never asks. See the event's own
			// doc comment for why conflating the two was a shipped defect.
			record.tokens = event.usage.totalTokens
			return
		case 'reasoning_started':
		case 'reasoning_delta':
			record.status = 'working'
			record.latestActivity = 'Thinking'
			return
		case 'reasoning_completed':
			record.status = 'working'
			record.latestActivity = 'Working'
			return
		case 'text_delta': {
			record.status = 'working'
			const id = `${record.viewId}:assistant:${event.messageId ?? event.runId}`
			const current = record.rows.at(-1)
			if (current?.kind === 'assistant' && current.id === id) {
				record.rows[record.rows.length - 1] = {
					...current,
					text: appendBounded(current.text, event.text),
				}
			} else {
				pushRow(record, {
					id,
					kind: 'assistant',
					text: bounded(event.text, MAX_ROW_CODE_UNITS),
				})
			}
			const assistant = record.rows.at(-1)
			const preview = assistant?.kind === 'assistant' ? oneLine(assistant.text) : ''
			record.latestActivity = bounded(
				preview ? `Answering · ${preview}` : 'Answering',
				MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS,
			)
			return
		}
		case 'tool_executing': {
			record.status = 'working'
			record.toolCalls = (record.toolCalls ?? 0) + 1
			const label = `${event.toolName}(${genericLabel(event.input)})`
			record.latestActivity = bounded(label, MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS)
			pushRow(record, {
				id: `${record.viewId}:tool:${event.toolUseId}`,
				kind: 'tool',
				text: bounded(label, MAX_ROW_CODE_UNITS),
				status: 'working',
			})
			return
		}
		case 'tool_progress': {
			const id = `${record.viewId}:tool:${event.toolUseId}`
			const index = record.rows.findIndex((row) => row.id === id)
			if (index < 0) return
			const row = record.rows[index]
			if (!row || row.kind !== 'tool') return
			record.rows[index] = {
				...row,
				detail: bounded(event.message, MAX_ROW_CODE_UNITS),
			}
			record.latestActivity = bounded(event.message, MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS)
			return
		}
		case 'tool_completed': {
			const id = `${record.viewId}:tool:${event.toolUseId}`
			const index = record.rows.findIndex((row) => row.id === id)
			if (index >= 0) {
				const row = record.rows[index]
				if (row?.kind === 'tool') {
					record.rows[index] = {
						...row,
						status: event.isError ? 'failed' : 'completed',
						...(event.result ? { detail: bounded(event.result, MAX_ROW_CODE_UNITS) } : {}),
					}
				}
			}
			record.latestActivity = event.isError ? `${event.toolName} failed` : `${event.toolName} done`
			return
		}
		case 'provider_retry':
			record.latestActivity = `Retrying (${event.attempt}/${event.maxRetries})`
			return
		case 'agent_completed':
			record.status =
				event.result.status === 'completed' &&
				(!event.result.stopReason || event.result.stopReason === 'end_turn')
					? 'completed'
					: 'failed'
			record.completedAt = Date.now()
			record.latestActivity = terminalLabel(record.status)
			return
		case 'agent_failed':
			record.status = 'failed'
			record.completedAt = Date.now()
			record.latestActivity = 'Failed'
			pushRow(record, {
				id: `${record.viewId}:agent-failed`,
				kind: 'system',
				text: bounded(event.error, MAX_ROW_CODE_UNITS),
			})
			return
		case 'agent_canceled':
			record.status = 'cancelled'
			record.completedAt = Date.now()
			record.latestActivity = 'Cancelled'
			return
		case 'run_failed':
			record.latestActivity = 'Failed'
			pushRow(record, {
				id: `${record.viewId}:run-failed`,
				kind: 'system',
				text: bounded(event.error, MAX_ROW_CODE_UNITS),
			})
			return
		default:
			return
	}
}

function pushRow(record: MutableActivity, row: SubagentTranscriptRow): void {
	record.rows.push(row)
	if (record.rows.length > MAX_TRANSCRIPT_ROWS) {
		record.rows.splice(0, record.rows.length - MAX_TRANSCRIPT_ROWS)
	}
}

function oneLine(value: string): string {
	return value
		.replace(/[\r\n]+/g, ' ')
		.replace(/\t/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

function statusOf(handle: TaskHandle): SubagentActivityStatus {
	if (handle.state === 'pending') return 'queued'
	if (handle.state === 'canceled') return 'cancelled'
	if (handle.state === 'failed' || handle.state === 'rejected') return 'failed'
	if (
		handle.result &&
		(handle.result.status !== 'completed' ||
			(handle.result.stopReason && handle.result.stopReason !== 'end_turn'))
	) {
		return handle.result.status === 'cancelled' ? 'cancelled' : 'failed'
	}
	if (isTerminalAgentTaskState(handle.state)) return 'completed'
	return 'working'
}

function isTerminal(status: SubagentActivityStatus): boolean {
	return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function terminalLabel(status: SubagentActivityStatus): string {
	switch (status) {
		case 'starting':
			return 'Starting'
		case 'queued':
			return 'Queued'
		case 'working':
			return 'Working'
		case 'completed':
			return 'Completed'
		case 'failed':
			return 'Failed'
		case 'cancelled':
			return 'Cancelled'
	}
}

function bounded(value: string, max: number): string {
	if (value.length <= max) return value
	const suffix = '… [clipped]'
	return `${value.slice(0, Math.max(0, max - suffix.length))}${suffix}`
}

function normalizedLabel(value: string | undefined, fallback: string, max: number): string {
	const raw = typeof value === 'string' ? value.trim() : ''
	let label = ''
	for (const point of raw) {
		const codePoint = point.codePointAt(0) ?? 0
		if (point === '\n' || point === '\r' || point === '\t') label += ' '
		else if (codePoint >= 0x20 && codePoint !== 0x7f) label += point
	}
	label = label.replace(/ +/g, ' ').trim()
	return bounded(label || fallback, max)
}

function normalizedPhaseOrder(value: number | undefined): number | undefined {
	if (
		typeof value !== 'number' ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value > MAX_AGENT_PHASE_ORDER
	)
		return undefined
	return value
}

function appendBounded(current: string, delta: string): string {
	const joined = current + delta
	if (joined.length <= MAX_ROW_CODE_UNITS) return joined
	const prefix = '… [earlier text clipped]\n'
	return prefix + joined.slice(-(MAX_ROW_CODE_UNITS - prefix.length))
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function cancellationLike(error: unknown): boolean {
	return error instanceof Error && (error.name === 'AbortError' || error.name === 'RunCancelled')
}
