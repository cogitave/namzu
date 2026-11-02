/**
 * What ended while nobody was talking to the model, and has not been told yet.
 *
 * Five kinds of news can wait here: a background command that exited, a
 * workflow run that ended, a message a running agent sent to the conversation,
 * a note about something the person did to an agent, and (kept on the session
 * itself) what a monitor said. Each is told to the model exactly once.
 *
 * That guarantee is a protocol with three parties. The kernel may deliver a
 * piece of news inside a running turn, at a request boundary; the host takes a
 * snapshot of what is still waiting when it admits a turn; and the snapshot is
 * committed only when that turn completes, because an early throw or an abort
 * never proves the model received it. This class holds the waiting news and the
 * three operations; the host decides when to call them.
 */

import type { RuntimeContextMessageKind } from '@namzu/sdk'

/** A note for the model about something the person did to a running agent. */
export interface DirectChildNotice {
	/** What the model is told. */
	readonly context: string
	/** What the conversation shows. */
	readonly label: string
	readonly kind: RuntimeContextMessageKind
}

/** Background command exits for one session; replaced when the session is. */
export interface JobNotices<Owner> {
	readonly ownerSession: Owner | null
	/** Exits the model has not been told. */
	readonly pending: Map<string, string>
	/** Exits the kernel already delivered; a late UI event for one is dropped. */
	readonly delivered: Set<string>
	/** Exits already painted as a row, so none is painted twice. */
	readonly shown: Set<string>
}

/** What a turn took at admission and may commit when it completes. */
export interface WakeSnapshot {
	readonly idleJobs: { readonly ids: readonly string[]; readonly text?: string }
	readonly directChild: ReadonlyMap<number, DirectChildNotice>
	readonly workflows: ReadonlyMap<string, string>
	readonly childMessages: ReadonlyMap<number, string>
}

export const EMPTY_WAKE_SNAPSHOT: WakeSnapshot = {
	idleJobs: { ids: [] },
	directChild: new Map(),
	workflows: new Map(),
	childMessages: new Map(),
}

/** News a running turn takes at a request boundary. */
export interface InTurnNews {
	readonly childNotices: ReadonlyArray<readonly [number, DirectChildNotice]>
	readonly workflowEnds: ReadonlyArray<readonly [string, string]>
	readonly childMessages: ReadonlyArray<readonly [number, string]>
}

/** What an idle wake turn takes at admission. */
export interface WakeTake {
	readonly ended: readonly string[]
	readonly jobLines: ReadonlyArray<readonly [string, string]>
}

export class WakeLedger<Owner = unknown> {
	#jobs: JobNotices<Owner> = {
		ownerSession: null,
		pending: new Map(),
		delivered: new Set(),
		shown: new Set(),
	}
	/** Exits that ended on their own; a stop the person asked for does not wake the model. */
	readonly #wakeJobIds = new Set<string>()
	#workflows = new Map<string, string>()
	#childMessages = new Map<number, string>()
	#childMessageSeq = 0
	readonly #directChild = new Map<number, DirectChildNotice>()
	#directChildSeq = 0

	/** The exits kept for the current session. Compare by identity to know a session changed. */
	jobs(): JobNotices<Owner> {
		return this.#jobs
	}

	/** A new session: its exits start empty. Returns them, so a listener can tell it is stale. */
	startJobs(owner: Owner | null): JobNotices<Owner> {
		this.#jobs = {
			ownerSession: owner,
			pending: new Map(),
			delivered: new Set(),
			shown: new Set(),
		}
		return this.#jobs
	}

	/**
	 * A background command exited. Kept for the model unless the kernel already
	 * delivered it; `wakes` is false for a stop the person asked for. Returns
	 * whether it was kept (so the idle session may wake).
	 */
	noteJobExit(jobs: JobNotices<Owner>, id: string, text: string, wakes: boolean): boolean {
		if (jobs.delivered.has(id)) return false
		jobs.pending.set(id, text)
		if (wakes) this.#wakeJobIds.add(id)
		return true
	}

	/** The kernel put these exits in front of the model during a turn. */
	jobNoticesDelivered(owner: Owner | null, ids: readonly string[]): void {
		if (this.#jobs.ownerSession !== owner) return
		for (const id of ids) {
			this.#jobs.delivered.add(id)
			this.#jobs.pending.delete(id)
		}
	}

	/** Painted once: true the first time for this id, false afterwards. */
	markJobShown(id: string): boolean {
		if (this.#jobs.shown.has(id)) return false
		this.#jobs.shown.add(id)
		return true
	}

	/** A new session: workflow news starts empty. */
	resetWorkflows(): void {
		this.#workflows = new Map()
	}

	noteWorkflowEnd(runId: string, text: string): void {
		this.#workflows.set(runId, text)
	}

	/** A new session: agent messages start empty. */
	resetChildMessages(): void {
		this.#childMessages = new Map()
	}

	/** What a running agent said, or that a background agent ended; told once. */
	noteChildMessage(text: string): void {
		this.#childMessages.set(++this.#childMessageSeq, text)
	}

	noteDirectChild(notice: DirectChildNotice): void {
		this.#directChild.set(++this.#directChildSeq, notice)
	}

	/** The conversation changed: notes about the old one's agents are not news. */
	clearDirectChild(): void {
		this.#directChild.clear()
	}

	/** True when a running turn has a note about an agent it was not handed at admission. */
	hasUnsnapshottedDirectChild(snapshot: WakeSnapshot): boolean {
		return [...this.#directChild.keys()].some((id) => !snapshot.directChild.has(id))
	}

	/**
	 * Whether an idle session has news worth waking for (`jobsCanWake` is false once the opt-in cap on automatic job wakes is spent). A monitor's own ledger is
	 * on the session, so its answer comes in.
	 */
	wakes(owner: Owner | null, monitorsWake: boolean, jobsCanWake = true): boolean {
		const jobs = this.#jobs
		return (
			this.#workflows.size > 0 ||
			this.#childMessages.size > 0 ||
			(jobsCanWake &&
				jobs.ownerSession === owner &&
				[...jobs.pending.keys()].some((id) => this.#wakeJobIds.has(id))) ||
			monitorsWake
		)
	}

	/**
	 * The idle wake turn takes everything waiting, now, at admission: a turn that
	 * was already running has had its chance to take it first, so nothing is said
	 * twice. Exits are marked delivered so a late event for them is dropped.
	 */
	takeForWake(owner: Owner | null): WakeTake {
		const ended = [...this.#workflows.values(), ...this.#childMessages.values()]
		this.#workflows.clear()
		this.#childMessages.clear()
		const jobs = this.#jobs
		const jobLines =
			jobs.ownerSession === owner
				? [...jobs.pending].filter(([id]) => this.#wakeJobIds.has(id))
				: []
		for (const [id] of jobLines) {
			jobs.delivered.add(id)
			jobs.pending.delete(id)
			this.#wakeJobIds.delete(id)
		}
		return { ended, jobLines }
	}

	/**
	 * What a turn is about to carry. Everything stays pending until
	 * {@link commit}: an early throw or an abort never proves the model got it.
	 */
	snapshot(owner: Owner | null): WakeSnapshot {
		const jobs = this.#jobs
		let idleJobs: WakeSnapshot['idleJobs'] = { ids: [] }
		if (jobs.ownerSession === owner && jobs.pending.size > 0) {
			const lines = [...jobs.pending.values()]
			idleJobs = {
				ids: [...jobs.pending.keys()],
				text: `Background jobs that ended since your last turn:\n${lines.map((l) => `- ${l}`).join('\n')}`,
			}
		}
		return {
			idleJobs,
			directChild: new Map(this.#directChild),
			workflows: new Map(this.#workflows),
			childMessages: new Map(this.#childMessages),
		}
	}

	/**
	 * A running turn reached a request boundary: it takes the news that arrived
	 * after its snapshot and removes the workflow and agent-message news (the
	 * notes about agents are removed only once the host has shown them).
	 */
	takeInTurn(snapshot: WakeSnapshot): InTurnNews {
		const childNotices = [...this.#directChild].filter(([id]) => !snapshot.directChild.has(id))
		const workflowEnds = [...this.#workflows].filter(([id]) => !snapshot.workflows.has(id))
		for (const [id] of workflowEnds) this.#workflows.delete(id)
		const childMessages = [...this.#childMessages].filter(([id]) => !snapshot.childMessages.has(id))
		for (const [id] of childMessages) this.#childMessages.delete(id)
		return { childNotices, workflowEnds, childMessages }
	}

	/** The host showed these notes about agents; they are told once. */
	dropDirectChild(ids: Iterable<number>): void {
		for (const id of ids) this.#directChild.delete(id)
	}

	/**
	 * The turn completed, so what it carried is told. `sameConversation` is false
	 * when the conversation changed under it; the agent, workflow and message
	 * news then belongs to nobody and is left alone.
	 */
	commit(snapshot: WakeSnapshot, owner: Owner | null, sameConversation: boolean): void {
		if (sameConversation) {
			for (const id of snapshot.directChild.keys()) this.#directChild.delete(id)
			for (const id of snapshot.workflows.keys()) this.#workflows.delete(id)
			for (const id of snapshot.childMessages.keys()) this.#childMessages.delete(id)
		}
		if (this.#jobs.ownerSession === owner) {
			for (const id of snapshot.idleJobs.ids) this.#jobs.pending.delete(id)
		}
	}
}
