import type { Run } from '../../types/run/entity.js'
import type { RunEvent } from '../../types/run/events.js'
import type { CompletedToolRecord, RunStore } from '../../types/run/store.js'

/**
 * Process-local {@link RunStore}: a run's evidence with no filesystem.
 *
 * The reason it ships rather than living in a test file is that it is the
 * only way to demonstrate the seam actually is one. A contract with a single
 * implementation is a refactor; the second implementation is what proves a
 * host could supply a third. It is also the parity partner for the disk
 * store — a memory store that answers differently from disk is worse than
 * none, because a host tests against one and ships the other.
 *
 * Deliberately not durable. It is for tests, for a single-process host that
 * genuinely wants a run's evidence to die with the process, and for
 * environments with no writable filesystem at all.
 */
export class InMemoryRunStore implements RunStore {
	private runId: string | null = null
	private parentRunId: string | undefined
	private meta: Run | null = null
	private messages: Run['messages'] = []
	private report: string | null = null
	private readonly events: RunEvent[] = []

	async initRun(runId: string, parentRunId?: string): Promise<string | null> {
		this.runId = runId
		this.parentRunId = parentRunId
		// No location, and that is the honest answer rather than a defect.
		// Callers render `null` as "this run is not on a filesystem"; a
		// synthesized path would put a directory that does not exist in front
		// of an operator.
		return null
	}

	private requireInit(): string {
		if (this.runId === null) {
			throw new Error('InMemoryRunStore not initialized — call initRun() first')
		}
		return this.runId
	}

	/** The run this store is bound to, and its parent when it has one. */
	get boundTo(): { runId: string; parentRunId?: string } | null {
		return this.runId === null
			? null
			: { runId: this.runId, ...(this.parentRunId ? { parentRunId: this.parentRunId } : {}) }
	}

	async writeRunMeta(run: Run): Promise<void> {
		this.requireInit()
		// Copied, not referenced. The caller keeps mutating this object for
		// the rest of the run, so storing it by reference would make every
		// historical read return the run's present state — a transcript that
		// silently rewrites itself is worse than no transcript.
		this.meta = structuredClone(run)
	}

	async writeMessages(run: Run): Promise<void> {
		this.requireInit()
		this.messages = structuredClone(run.messages)
	}

	async appendEvent(event: RunEvent): Promise<void> {
		this.requireInit()
		// Stamped on write, exactly as the disk store stamps its transcript
		// line — a parity test compares the two read-backs, and a timestamp
		// present in one medium and absent in the other would make identical
		// runs look different depending on where they were recorded.
		this.events.push({ ...event, timestamp: Date.now() } as unknown as RunEvent)
	}

	async writeReport(content: string): Promise<string | null> {
		this.requireInit()
		this.report = content
		return null
	}

	async readCompletedTools(): Promise<Map<string, CompletedToolRecord>> {
		this.requireInit()
		const completed = new Map<string, CompletedToolRecord>()
		for (const event of this.events) {
			const e = event as unknown as Record<string, unknown>
			if (e.type !== 'tool_completed') continue
			const toolUseId = e.toolUseId
			const toolName = e.toolName
			if (typeof toolUseId !== 'string' || typeof toolName !== 'string') continue
			// Last write wins: a retried tool emits one event per attempt and
			// the final one is what actually answered the call. Same rule the
			// disk store applies, and it has to be the same rule — a resumed
			// run must not depend on which backend it was recorded with.
			completed.set(toolUseId, {
				toolUseId,
				toolName,
				result: typeof e.result === 'string' ? e.result : '',
				isError: e.isError === true,
			})
		}
		return completed
	}

	getRunDir(): string | null {
		return null
	}

	// `addToIndex` is deliberately not implemented. It maintains a browsable
	// catalogue for a human reading a directory, and there is no directory
	// here. The optional method exists on the contract precisely so a backend
	// can decline it rather than implement a no-op that looks like a listing.

	/** Everything recorded for the bound run, for tests and parity checks. */
	snapshot(): {
		meta: Run | null
		messages: Run['messages']
		report: string | null
		events: readonly RunEvent[]
	} {
		return { meta: this.meta, messages: this.messages, report: this.report, events: this.events }
	}
}
