/**
 * The workflow runs of one session: started in the background, observed by the
 * terminal, stopped or trimmed by the operator.
 *
 * A run is `WorkflowRuntime.run()` left going after the tool call that started
 * it returned. The registry folds its events into a {@link WorkflowRunView}
 * (what the rail and the detail read), hands out the controls the runtime
 * gave (`skipAgent`) and an abort, and says once when the run ends. It knows
 * nothing about subagents: starting an agent is the `spawnAgent` the host
 * passes in.
 */

import type {
	WorkflowAgentRequest,
	WorkflowControl,
	WorkflowEvent,
	WorkflowJournal,
	WorkflowLimits,
	WorkflowMeta,
	WorkflowRunResult,
	WorkflowSpawnAgent,
} from '@namzu/sdk'
import { WorkflowRuntime } from '@namzu/sdk'

import {
	type WorkflowRunView,
	attachAgentView,
	closeOpenAgents,
	initialRunView,
	reduceRunView,
} from './view.js'

/** What the registry tells the host when a run ends. */
export interface WorkflowRunEnd {
	readonly view: WorkflowRunView
	readonly result?: WorkflowRunResult
}

export interface StartWorkflowRun {
	readonly runId: string
	readonly meta: WorkflowMeta
	readonly script: string
	readonly args?: unknown
	readonly limits?: WorkflowLimits
	readonly journal?: WorkflowJournal
	/**
	 * Start one agent. `viewed` reports the agent's row in the monitor as soon
	 * as it exists; the registry records it on the run so the detail can open
	 * the agent's own transcript.
	 */
	readonly spawn: (
		request: WorkflowAgentRequest,
		signal: AbortSignal,
		viewed: (viewId: string) => void,
	) => ReturnType<WorkflowSpawnAgent>
	/**
	 * Called once, the first time the script asks for an agent (before it has
	 * started). A run that ends without this ever being called never started
	 * any work: the `workflow` tool answers for it inline.
	 */
	readonly onFirstAgent?: () => void
	/** Called once, after the run has ended and its last view is stored. */
	readonly onEnd?: (end: WorkflowRunEnd) => void | Promise<void>
}

interface LiveRun {
	view: WorkflowRunView
	readonly abort: AbortController
	control?: WorkflowControl
	/** The end has been announced to the host (its `onEnd` has finished). */
	finalized: boolean
}

export class WorkflowRunRegistry {
	private readonly runs = new Map<string, LiveRun>()
	private readonly listeners = new Set<() => void>()
	private readonly runtime: WorkflowRuntime
	private readonly now: () => number
	private notifyTimer: ReturnType<typeof setTimeout> | undefined
	private closed = false

	constructor(
		options: {
			readonly now?: () => number
			readonly runtime?: WorkflowRuntime
		} = {},
	) {
		this.now = options.now ?? Date.now
		this.runtime = options.runtime ?? new WorkflowRuntime()
	}

	list(): readonly WorkflowRunView[] {
		return [...this.runs.values()].map((run) => run.view)
	}

	get(runId: string): WorkflowRunView | undefined {
		return this.runs.get(runId)?.view
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	/** Runs that have not ended. */
	running(): readonly WorkflowRunView[] {
		return this.list().filter((view) => view.status === 'running')
	}

	/** Begin a run. Returns at once; the run goes on in the background. */
	start(input: StartWorkflowRun): WorkflowRunView {
		if (this.closed) throw new Error('Workflows are closed for this session.')
		const run: LiveRun = {
			view: initialRunView({
				runId: input.runId,
				name: input.meta.name,
				description: input.meta.description,
				phases: input.meta.phases,
				at: this.now(),
			}),
			abort: new AbortController(),
			finalized: false,
		}
		this.runs.set(input.runId, run)
		this.notifySoon(true)
		let firstAgentSeen = false
		const settle = async (result: WorkflowRunResult | undefined, error?: string): Promise<void> => {
			const at = this.now()
			if (run.view.status === 'running') {
				run.view = {
					...run.view,
					status: run.abort.signal.aborted ? 'stopped' : 'failed',
					endedAt: at,
					...(error !== undefined ? { error } : {}),
				}
			}
			run.view = closeOpenAgents(run.view, at)
			try {
				await input.onEnd?.({ view: run.view, ...(result ? { result } : {}) })
			} catch {
				// A listener bug must not leave the run looking alive.
			}
			run.finalized = true
			// After the end is announced, so a reader woken by this sees both.
			this.notifySoon(true)
		}
		void this.runtime
			.run({
				script: input.script,
				...(input.args !== undefined ? { args: input.args } : {}),
				...(input.limits ? { limits: input.limits } : {}),
				...(input.journal ? { journal: input.journal } : {}),
				runId: input.runId,
				signal: run.abort.signal,
				onControl: (control) => {
					run.control = control
				},
				onEvent: (event: WorkflowEvent) => {
					run.view = reduceRunView(run.view, event)
					if (event.type === 'workflow_agent' && !firstAgentSeen) {
						firstAgentSeen = true
						input.onFirstAgent?.()
					}
					this.notifySoon(event.type !== 'workflow_agent' || event.state !== 'progress')
				},
				spawnAgent: (request, signal) =>
					input.spawn(request, signal, (viewId) => {
						run.view = attachAgentView(run.view, request.index, viewId)
						this.notifySoon(false)
					}),
			})
			.then(
				(result) => settle(result),
				(error: unknown) =>
					settle(undefined, error instanceof Error ? error.message : String(error)),
			)
		return run.view
	}

	/**
	 * Resolves once no run is going, or when `signal` aborts (whichever is first).
	 * A run's own limits bound the wait: the runtime stops one at its duration cap.
	 */
	whenIdle(signal?: AbortSignal): Promise<void> {
		// A run counts until its end has been announced, not only until it has
		// ended: a caller woken by this must find the announcement already made.
		const going = (): boolean => [...this.runs.values()].some((run) => !run.finalized)
		if (!going() || signal?.aborted) return Promise.resolve()
		return new Promise<void>((resolve) => {
			const done = (): void => {
				off()
				signal?.removeEventListener('abort', done)
				resolve()
			}
			const off = this.subscribe(() => {
				if (!going()) done()
			})
			signal?.addEventListener('abort', done, { once: true })
		})
	}

	/** Stop a run: queued agents never start, running ones are aborted. False when it is not running. */
	stop(runId: string): boolean {
		const run = this.runs.get(runId)
		if (!run || run.view.status !== 'running') return false
		run.abort.abort(new Error('The operator stopped this workflow.'))
		return true
	}

	/** Skip one agent of a run. False when it is not running or already settled. */
	skipAgent(runId: string, index: number): boolean {
		const run = this.runs.get(runId)
		if (!run || run.view.status !== 'running') return false
		return run.control?.skipAgent(index) ?? false
	}

	/** Which run and agent a monitor row stands for, if any. */
	agentOf(viewId: string): { readonly runId: string; readonly index: number } | undefined {
		for (const run of this.runs.values()) {
			const agent = run.view.agents.find((item) => item.viewId === viewId)
			if (agent) return { runId: run.view.runId, index: agent.index }
		}
		return undefined
	}

	/**
	 * Forget one run that has ended, so nothing lists it. For a run the tool
	 * answered inline: it never became background work. False when the run is
	 * unknown or still going.
	 */
	discard(runId: string): boolean {
		const run = this.runs.get(runId)
		if (!run || run.view.status === 'running') return false
		this.runs.delete(runId)
		this.notifySoon(true)
		return true
	}

	/** Forget runs that have ended (a new conversation). Running ones are stopped first. */
	reset(): void {
		for (const run of this.runs.values()) run.abort.abort(new Error('The conversation changed.'))
		this.runs.clear()
		this.notifySoon(true)
	}

	close(): void {
		this.closed = true
		for (const run of this.runs.values()) run.abort.abort(new Error('The session ended.'))
		if (this.notifyTimer) clearTimeout(this.notifyTimer)
		this.notifyTimer = undefined
		this.listeners.clear()
	}

	private notifySoon(now: boolean): void {
		if (this.closed) return
		if (now) {
			if (this.notifyTimer) clearTimeout(this.notifyTimer)
			this.notifyTimer = undefined
			for (const listener of [...this.listeners]) listener()
			return
		}
		if (this.notifyTimer) return
		this.notifyTimer = setTimeout(() => {
			this.notifyTimer = undefined
			for (const listener of [...this.listeners]) listener()
		}, 100)
		this.notifyTimer.unref?.()
	}
}
