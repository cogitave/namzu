import type { PeerSessionState } from '@namzu/sdk'
import type { ChildSession } from './session.js'
import { type Dot, type SessionActivity, aggregateDot, deriveActivity, dotFor } from './status.js'
import {
	type Node,
	type SplitDir,
	contains,
	leaf,
	leaves,
	removeLeaf,
	splitLeaf,
} from './tiling.js'

/** One tab of a space: the tiling of its panes, which one has focus, and whether it is zoomed. */
export interface Tab {
	/** The name the user gave it; without one the tab shows its number. */
	name?: string
	root: Node
	focus: Entry
	zoomed: boolean
}

/** A project folder; the sidebar lists these on top. */
export interface Space {
	readonly id: string
	name: string
	readonly cwd: string
	/** The account id the last session started here ran on; the picker offers it first. */
	lastAccount?: string
	readonly tabs: Tab[]
	/** The tab shown when the space is shown. */
	activeTab: Tab | undefined
}

/** One pane's session. The terminal behind it starts only when the pane is first opened. */
export class Entry {
	child: ChildSession | undefined
	/** What the session's own terminal last reported through the peer feed. */
	reported: PeerSessionState | undefined
	/** A turn finished while nobody was looking at this session. */
	unseen = false
	/** Rows scrolled back into the session's history; 0 follows the live screen. */
	scrollBack = 0
	/** The label of the non-usual account the session is on, as its terminal last reported. */
	account: string | undefined
	conversationId: string | undefined
	limited = false
	/** When the spent allowance is expected back (epoch ms), if the terminal knows. */
	limitedUntil: number | undefined
	/** The account id picked when the session was started; what a first launch binds. */
	pickedAccount: string | undefined
	/** The session the command itself started, which alone receives the command's options. */
	first = false
	/** The conversation to open when the session first starts, for one restored from a previous run. */
	resume: string | undefined
	/** Whether its conversation is already open in another terminal: it is not started. */
	openElsewhere = false
	/** Restored from a previous run: its folder is looked at again each time it is opened. */
	verifyFolder = false
	/** Its folder was not found when it was last opened, so it is not started. */
	folderMissing = false
	/** The check for that is running. */
	checking = false
	/** When its activity last changed, as a count that only grows; the priority order puts the newest first. */
	changedAt = 0
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
	private ticks = 0

	/** The session with focus: the focused pane of the shown tab of the shown space. */
	get selected(): Entry | undefined {
		return this.current
	}

	spaceOf(entry: Entry): Space {
		return this.spaces.find((s) => s.id === entry.spaceId) as Space
	}

	entriesOf(space: Space): Entry[] {
		return this.entries.filter((e) => e.spaceId === space.id)
	}

	tabOf(entry: Entry): Tab | undefined {
		return this.spaceOf(entry)?.tabs.find((t) => contains(t.root, entry))
	}

	/** The tab being shown. */
	get shownTab(): Tab | undefined {
		const entry = this.current
		return entry ? this.tabOf(entry) : undefined
	}

	addSpace(cwd: string, name: string): Space {
		const space: Space = {
			id: `space-${++this.counter}`,
			name,
			cwd,
			tabs: [],
			activeTab: undefined,
		}
		this.spaces.push(space)
		return space
	}

	/** A session that is not in any tab yet; give it a place with `addTab` or `splitBeside`. */
	addSession(space: Space, slot: string, label?: string): Entry {
		const own = this.entriesOf(space)
		const entry = new Entry(slot, space.id, label ?? this.freeLabel(own))
		this.entries.push(entry)
		this.current ??= entry
		return entry
	}

	/** A tab holding one pane, after the space's others. */
	addTab(space: Space, entry: Entry, name?: string): Tab {
		const tab: Tab = {
			root: leaf(entry),
			focus: entry,
			zoomed: false,
			...(name ? { name } : {}),
		}
		space.tabs.push(tab)
		space.activeTab ??= tab
		return tab
	}

	/** A tab built from a whole tree, as when a layout is restored. */
	addTree(space: Space, root: Node, focus: Entry, name?: string, zoomed = false): Tab {
		const tab: Tab = { root, focus, zoomed, ...(name ? { name } : {}) }
		space.tabs.push(tab)
		space.activeTab ??= tab
		return tab
	}

	/** Splits the pane of `target` and puts `created` in the new half, which takes focus. */
	splitBeside(target: Entry, created: Entry, dir: SplitDir): void {
		const tab = this.tabOf(target)
		if (!tab) return
		tab.root = splitLeaf(tab.root, target, created, dir)
		tab.zoomed = false
		tab.focus = created
	}

	/** `session N` for the smallest N not already used, so a name never repeats after a close. */
	private freeLabel(own: readonly Entry[]): string {
		const used = new Set(own.map((e) => e.label))
		for (let n = own.length + 1; ; n++) if (!used.has(`session ${n}`)) return `session ${n}`
	}

	/** Whether the entry's pane is on screen: in the shown tab of the shown space. */
	isVisible(entry: Entry): boolean {
		const tab = this.shownTab
		return tab !== undefined && contains(tab.root, entry)
	}

	/** Shows an entry's tab with that pane focused; looking at panes clears their "finished" mark. */
	select(entry: Entry): void {
		if (!this.entries.includes(entry)) return
		const space = this.spaceOf(entry)
		const tab = this.tabOf(entry)
		if (tab) {
			tab.focus = entry
			space.activeTab = tab
		}
		this.current = entry
		entry.scrollBack = 0
		for (const seen of tab ? leaves(tab.root) : [entry]) seen.unseen = false
	}

	/** Re-reads an entry's activity and marks a finished turn nobody was watching. */
	update(entry: Entry): void {
		const before = entry.observe()
		const now = entry.activity()
		if (before !== now) entry.changedAt = ++this.ticks
		if ((before === 'working' || before === 'needs-approval') && now === 'idle') {
			if (!this.isVisible(entry)) entry.unseen = true
		}
	}

	spaceDot(space: Space): Dot {
		return aggregateDot(this.entriesOf(space).map((e) => e.dot()))
	}

	/**
	 * Removes a session and its pane: the neighbour takes the room and focus. A tab
	 * left empty goes, and so does a space left with no tab.
	 */
	removeEntry(entry: Entry): void {
		const index = this.entries.indexOf(entry)
		if (index < 0) return
		const space = this.spaces.find((s) => s.id === entry.spaceId)
		const tab = space?.tabs.find((t) => contains(t.root, entry))
		let landing: Entry | undefined
		this.entries.splice(index, 1)
		if (space && tab) {
			const { root, next } = removeLeaf(tab.root, entry)
			if (root) {
				tab.root = root
				tab.zoomed = tab.zoomed && leaves(root).length > 1
				if (tab.focus === entry) tab.focus = next ?? (leaves(root)[0] as Entry)
				landing = tab.focus
			} else {
				const at = space.tabs.indexOf(tab)
				space.tabs.splice(at, 1)
				if (space.activeTab === tab)
					space.activeTab = space.tabs[Math.min(at, space.tabs.length - 1)]
				landing = space.activeTab?.focus
			}
		}
		if (space && space.tabs.length === 0) this.spaces.splice(this.spaces.indexOf(space), 1)
		if (this.current === entry) {
			const next = landing ?? this.entries[Math.min(index, this.entries.length - 1)]
			this.current = next
			if (next) {
				const there = this.spaces.find((s) => s.id === next.spaceId)
				const nextTab = there?.tabs.find((t) => contains(t.root, next))
				if (there && nextTab) there.activeTab = nextTab
				for (const seen of nextTab ? leaves(nextTab.root) : [next]) seen.unseen = false
			}
		}
	}

	removeSpace(space: Space): Entry[] {
		const gone = this.entriesOf(space)
		for (const entry of gone) this.removeEntry(entry)
		return gone
	}

	/** Takes a tab out with its sessions. */
	removeTab(space: Space, tab: Tab): Entry[] {
		const gone = leaves(tab.root)
		for (const entry of gone) this.removeEntry(entry)
		return gone
	}
}
