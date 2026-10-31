import type { PeerSessionState } from '@namzu/sdk'
import type { ChildSession } from './session.js'
import { type Dot, type SessionActivity, aggregateDot, deriveActivity, dotFor } from './status.js'

/** A project folder; the sidebar lists these on top. */
export interface Space {
	readonly id: string
	name: string
	readonly cwd: string
}

/** One session row. The terminal behind it starts only when the row is first opened. */
export class Entry {
	child: ChildSession | undefined
	/** What the session's own terminal last reported through the peer feed. */
	reported: PeerSessionState | undefined
	/** A turn finished while nobody was looking at this session. */
	unseen = false
	/** Rows scrolled back into the session's history; 0 follows the live screen. */
	scrollBack = 0
	account: string | undefined
	conversationId: string | undefined
	limited = false
	private seen: SessionActivity = 'not-started'

	constructor(
		readonly slot: string,
		readonly spaceId: string,
		public label: string,
	) {}

	activity(): SessionActivity {
		return deriveActivity(this.child ? this.child.status : 'none', this.reported)
	}

	dot(): Dot {
		return dotFor(this.activity(), this.unseen)
	}

	/** Records the activity just observed; returns the previous one. */
	observe(): SessionActivity {
		const previous = this.seen
		this.seen = this.activity()
		return previous
	}
}

/**
 * The spaces, their sessions and which session is shown. Knows nothing about
 * terminals beyond what an entry's child reports about itself.
 */
export class Roster {
	readonly spaces: Space[] = []
	readonly entries: Entry[] = []
	private current: Entry | undefined
	private counter = 0

	get selected(): Entry | undefined {
		return this.current
	}

	spaceOf(entry: Entry): Space {
		return this.spaces.find((s) => s.id === entry.spaceId) as Space
	}

	entriesOf(space: Space): Entry[] {
		return this.entries.filter((e) => e.spaceId === space.id)
	}

	addSpace(cwd: string, name: string): Space {
		const space: Space = { id: `space-${++this.counter}`, name, cwd }
		this.spaces.push(space)
		return space
	}

	addSession(space: Space, slot: string, label?: string): Entry {
		const own = this.entriesOf(space)
		const entry = new Entry(slot, space.id, label ?? `session ${own.length + 1}`)
		this.entries.push(entry)
		this.current ??= entry
		return entry
	}

	/** Shows an entry; looking at a session clears its "finished" mark. */
	select(entry: Entry): void {
		if (!this.entries.includes(entry)) return
		this.current = entry
		entry.unseen = false
		entry.scrollBack = 0
	}

	/** Re-reads an entry's activity and marks a finished turn nobody was watching. */
	update(entry: Entry): void {
		const before = entry.observe()
		const now = entry.activity()
		if ((before === 'working' || before === 'needs-approval') && now === 'idle') {
			if (entry !== this.current) entry.unseen = true
		}
	}

	spaceDot(space: Space): Dot {
		return aggregateDot(this.entriesOf(space).map((e) => e.dot()))
	}

	/** Removes a session; the nearest remaining one in its space (or any) is shown next. */
	removeEntry(entry: Entry): void {
		const index = this.entries.indexOf(entry)
		if (index < 0) return
		this.entries.splice(index, 1)
		const space = this.spaces.find((s) => s.id === entry.spaceId)
		if (space && this.entriesOf(space).length === 0)
			this.spaces.splice(this.spaces.indexOf(space), 1)
		if (this.current === entry) {
			const sameSpace = this.entries.filter((e) => e.spaceId === entry.spaceId)
			const next = sameSpace[0] ?? this.entries[Math.min(index, this.entries.length - 1)]
			this.current = next
			if (next) next.unseen = false
		}
	}

	removeSpace(space: Space): Entry[] {
		const gone = this.entriesOf(space)
		for (const entry of gone) this.removeEntry(entry)
		return gone
	}
}
