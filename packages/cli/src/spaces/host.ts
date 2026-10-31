import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { ATTR_BOLD, ATTR_INVERSE, ATTR_UNDERLINE } from '../terminal/host/cell.js'
import { Frame, type Rect } from '../terminal/host/frame.js'
import { DiffWriter } from '../terminal/host/writer.js'
import type { HostPtyModule } from '../terminal/pty.js'
import { GitCache, type GitLookup, gitLookup } from './git.js'
import { type GotoRow, currentRow, filterGoto, gotoRows } from './goto.js'
import {
	CLEAR,
	type InputMode,
	InputRouter,
	type KeyContext,
	type MouseEvent,
	type NavKey,
} from './input.js'
import { type ActionId, bindingFor, helpRows } from './keymap.js'
import {
	DEFAULT_SIDEBAR,
	type Layout,
	SIDEBAR_DEFAULT,
	type SidebarSetting,
	clampSidebarWidth,
	computeLayout,
} from './layout.js'
import {
	type Hit,
	type ListSpec,
	type ModalSpec,
	type Screen,
	type Surface,
	dimFrame,
	drawBox,
	drawList,
	drawModal,
	drawPopup,
	hitSurface,
	layoutList,
	layoutModal,
	layoutPopup,
} from './overlay.js'
import { type Palette, advertisesTruecolor, paletteFor } from './palette.js'
import { type PeerSource, recordForSlot } from './peers.js'
import type { Prefix } from './prefix.js'
import { type Entry, Roster, type Space, type Tab } from './roster.js'
import { ChildSession, type SessionSpec } from './session.js'
import {
	type AgentOrder,
	type SidebarScroll,
	clampScroll,
	dotStyle,
	drawRule,
	drawSidebar,
	endedMessage,
	geometry,
	hitTest,
	regionAt,
	ruleRow,
} from './sidebar.js'
import type { SavedLayout, SavedNode, SavedTab, SpacesStore } from './store.js'
import { drawTabBar, layoutTabBar, tabBarTarget } from './tabbar.js'
import {
	type Direction,
	type Divider,
	MIN_PANE_HEIGHT,
	MIN_PANE_WIDTH,
	type Node,
	type Placement,
	type SplitDir,
	dividerAt,
	leaf,
	leaves,
	neighbour,
	paneAt,
	placeTab,
	ratioFor,
	resizeAt,
	swapLeaves,
} from './tiling.js'

export interface HostInput {
	on(event: 'data', listener: (chunk: string | Buffer) => void): unknown
	off(event: 'data', listener: (chunk: string | Buffer) => void): unknown
	setEncoding?(encoding: BufferEncoding): unknown
	setRawMode?(raw: boolean): unknown
	resume?(): unknown
	pause?(): unknown
}

export interface HostOutput {
	write(data: string): unknown
	readonly columns: number
	readonly rows: number
	on(event: 'resize', listener: () => void): unknown
	off(event: 'resize', listener: () => void): unknown
}

/** Runs `run` after `ms`; the returned function cancels it. Injected so tests own the clock. */
export type Schedule = (run: () => void, ms: number) => () => void

export const realSchedule: Schedule = (run, ms) => {
	const timer = setTimeout(run, ms)
	return () => clearTimeout(timer)
}

/** What the host asks of the program that starts a session. */
export interface SessionRequest {
	readonly cwd: string
	/** Identifies the session to the feed; the program reports it back in its live record. */
	readonly slot: string
	/** True for the session the command itself started, which alone receives the command's own options. */
	readonly first: boolean
	/** The account id picked for this session when it started. */
	readonly account?: string
	/** The label of the account the session was last reported on; a resumed one needs its home. */
	readonly accountLabel?: string
	/** The conversation to open again, for a session restored from a previous run. */
	readonly resume?: string
}

/** An account a new session can start on. */
export interface HostAccount {
	readonly id: string
	readonly label: string
	readonly provider: string
	/** The private Codex home of a Codex account; the session's environment points at it. */
	readonly codexHome?: string
}

/** Which conversation, in which folder, a restored session wants to open. */
export interface ConversationQuery {
	readonly cwd: string
	readonly conversationId: string
}

export interface SpacesHostOptions {
	readonly input: HostInput
	readonly output: HostOutput
	readonly binding: HostPtyModule
	/** The program for a session. */
	readonly spec: (request: SessionRequest) => SessionSpec
	/** The space the host opens with, and starts a session in. */
	readonly folder: { readonly cwd: string; readonly name: string }
	/** Spaces and sessions shown but not started until opened. */
	readonly listed?: readonly { cwd: string; name: string; sessions: number }[]
	readonly prefix: Prefix
	/** The accounts a new session can start on; none means every session starts on the usual sign-in. */
	readonly accounts?: () => readonly HostAccount[]
	/** Where the layout is remembered between runs. */
	readonly store?: SpacesStore
	/** The layout of the previous run, shown at start with its sessions not yet started. */
	readonly restored?: SavedLayout
	/** True when the command carries its own options, which then start a fresh session instead of restoring focus. */
	readonly freshFirst?: boolean
	/** Whether a conversation is already open in another terminal; asked before a restored session starts. */
	readonly inUseElsewhere?: (query: ConversationQuery) => Promise<boolean>
	/** Whether to draw in true colour; by default what the terminal advertises through COLORTERM. */
	readonly truecolor?: boolean
	readonly schedule?: Schedule
	/** Reads a folder's branch for the sidebar; asked after the first frame, never while one is drawn. */
	readonly git?: GitLookup
	/** The clock, for the double-click that resets the sidebar's width. */
	readonly now?: () => number
	/** How a session's whole process tree is ended; the default signals its process group. */
	readonly kill?: ConstructorParameters<typeof ChildSession>[4]
	/** Where the sessions' states come from; without it every started session shows as starting. */
	readonly peers?: PeerSource
	readonly newSlot?: () => string
	readonly isDirectory?: (path: string) => boolean
	readonly homeDirectory?: string
}

/** At most about 60 frames a second. */
const FRAME_MS = 16
/** How often the records are read when the file watcher says nothing. */
const POLL_MS = 1000
/** How often each terminal is asked directly, to catch a change that was never written. */
const RECONCILE_MS = 2500
/** How long a change waits before the layout is written, so a burst is one write. */
const SAVE_MS = 250
/** How long a session gets to save itself after a hang-up before it is ended outright. */
const QUIT_GRACE_MS = 3000
/** How often each space's branch is read again. */
const GIT_MS = 5000
/** A space shown again within this long of its last look is not looked at again. */
const GIT_STALE_MS = 1500
/** Two presses on the sidebar's edge within this long reset its width. */
const DOUBLE_CLICK_MS = 400
/** Rows one wheel notch moves. */
const WHEEL_ROWS = 3

const ENTER_SCREEN = '\x1b[?1049h\x1b[2J\x1b[?1000h\x1b[?1002h\x1b[?1006h'
/** Drawing errors in a row before the host closes instead of retrying. */
const MAX_PAINT_FAILURES = 3
const LEAVE_SCREEN = '\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[?25h\x1b[?1049l'

type Prompt = {
	kind: 'folder' | 'new-space' | 'rename-session' | 'rename-space' | 'rename-tab'
	value: string
	/** A tab that was just made: it asks for a name instead of changing one. */
	fresh?: boolean
	error?: string
}
type Confirm = 'quit' | 'close-space'
/** The popup behind the sidebar's "menu". */
const MENU_ITEMS = ['accounts', 'add account', 'sidebar', 'keybinds', 'quit'] as const
interface Menu {
	index: number
}
/** The account choice offered when a session is started. */
interface Picker {
	readonly space: Space
	readonly choices: readonly {
		readonly id: string | undefined
		readonly text: string
	}[]
	index: number
}
/** The keybinds overlay: the key map, scrolled. */
interface Help {
	scroll: number
}
/** The go-to overlay: a typed filter over the tree of spaces, tabs and panes. */
interface Goto {
	query: string
	index: number
	scroll: number
}
/** The accounts overlay: what the menu's "accounts" shows. */
interface Accounts {
	scroll: number
}
/** What a right-click was on. */
type ContextTarget =
	| { readonly kind: 'space'; readonly space: Space }
	| { readonly kind: 'tab'; readonly tab: Tab }
	| { readonly kind: 'pane'; readonly entry: Entry }
type ContextItem = 'Rename' | 'New tab' | 'Split right' | 'Split down' | 'Zoom' | 'Close'
const CONTEXT_ITEMS: Record<ContextTarget['kind'], readonly ContextItem[]> = {
	space: ['Rename', 'New tab', 'Close'],
	tab: ['Rename', 'Close'],
	pane: ['Rename', 'Split right', 'Split down', 'Zoom', 'Close'],
}
interface Context {
	readonly target: ContextTarget
	readonly at: { readonly x: number; readonly y: number }
	index: number
}

function defaultIsDirectory(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).isDirectory()
	} catch {
		return false
	}
}

/**
 * The spaces shell: a sidebar of spaces and sessions, and beside it the shown
 * space's tab, a tiling of panes, each a session.
 *
 * It draws and routes keys and nothing else. Each session is a whole `namzu`
 * running in its own pseudo-terminal, so a session that crashes greys its row and
 * the rest keep running. What a session is doing comes from the live record its
 * terminal publishes, never from reading its screen.
 */
export class SpacesHost {
	readonly roster = new Roster()
	private sidebar: SidebarSetting = DEFAULT_SIDEBAR
	private split = 0.5
	private order: AgentOrder = 'grouped'
	private menu: Menu | undefined
	private sidebarScroll: SidebarScroll = { spaces: 0, agents: 0 }
	private sidebarDrag: 'width' | 'split' | undefined
	private lastEdgePress: number | undefined
	private readonly git: GitCache
	private gitStarted = false
	private cancelGit: (() => void) | undefined
	private confirm: Confirm | undefined
	private prompt: Prompt | undefined
	private picker: Picker | undefined
	private help: Help | undefined
	private goto: Goto | undefined
	private accountList: Accounts | undefined
	private context: Context | undefined
	/** A space being dragged in the sidebar, and the place it would land. */
	private reorder: { space: Space; to: number } | undefined
	private cancelSave: (() => void) | undefined
	private forgetAll = false
	private notice: string | undefined
	private pasteOn = false
	private pending: (() => void) | undefined
	private rendering: Promise<void> = Promise.resolve()
	private closed = false
	private quitting = false
	private paintFailures = 0
	private cancelKill: (() => void) | undefined
	private cancelPoll: (() => void) | undefined
	private cancelReconcile: (() => void) | undefined
	private stopWatching: (() => void) | undefined
	private reconciling = false
	private readonly leaving: ChildSession[] = []
	private readonly palette: Palette
	/** A border being dragged: the split it moves and where on the border it was grabbed. */
	private drag: { split: Divider['split']; offset: number } | undefined
	private readonly router: InputRouter
	private readonly writer = new DiffWriter()
	private readonly schedule: Schedule
	private finish!: (code: number) => void
	/** Resolves with the exit code once the host has left the terminal alone. */
	readonly done: Promise<number> = new Promise((resolve) => {
		this.finish = resolve
	})

	private readonly onData = (chunk: string | Buffer): void =>
		this.handleInput(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
	private readonly onResize = (): void => this.relayout()
	/** If the process ends without a clean close, still hand the terminal back and stop the sessions. */
	private readonly onProcessExit = (): void => {
		if (this.closed) return
		// The write waiting for its delay would be lost with the process, so it happens now.
		this.cancelSave?.()
		this.cancelSave = undefined
		this.writeLayout()
		this.closed = true
		try {
			this.options.input.setRawMode?.(false)
			this.options.output.write(LEAVE_SCREEN)
		} catch {
			// The terminal may already be gone.
		}
		for (const session of this.everyChild()) {
			try {
				session.stop('SIGHUP')
			} catch {
				// Already ended.
			}
		}
	}

	constructor(private readonly options: SpacesHostOptions) {
		this.router = new InputRouter(options.prefix)
		this.schedule = options.schedule ?? realSchedule
		this.palette = paletteFor(options.truecolor ?? advertisesTruecolor(process.env))
		this.git = new GitCache(
			options.git ?? gitLookup,
			() => this.requestRender(),
			options.now ?? Date.now,
		)
		const saved = options.restored?.sidebar
		if (saved) {
			this.sidebar = {
				collapsed: saved.collapsed === true,
				width: clampSidebarWidth(saved.width ?? SIDEBAR_DEFAULT),
			}
			if (saved.split !== undefined) this.split = saved.split
			if (saved.order) this.order = saved.order
		}
	}

	start(): void {
		const { input, output } = this.options
		output.write(ENTER_SCREEN)
		input.setEncoding?.('utf8')
		input.setRawMode?.(true)
		input.resume?.()
		input.on('data', this.onData)
		output.on('resize', this.onResize)
		process.once('exit', this.onProcessExit)
		this.open(this.options.restored ? this.restore(this.options.restored) : this.fresh())
		this.armPoll()
		this.armReconcile()
		this.stopWatching = this.options.peers?.watch?.(() => this.readStatus())
		this.requestRender()
	}

	// --- sessions --------------------------------------------------------------

	/** The first run: the current folder as a space with the session the command started. */
	private fresh(): Entry {
		const space = this.roster.addSpace(this.options.folder.cwd, this.options.folder.name)
		const entry = this.newTabIn(space)
		entry.first = true
		for (const listed of this.options.listed ?? []) {
			const other = this.roster.addSpace(listed.cwd, listed.name)
			for (let i = 0; i < listed.sessions; i++) this.newTabIn(other)
		}
		return entry
	}

	/**
	 * Brings back the previous run's spaces, tabs and panes, none of them started.
	 * The one shown is where focus was, unless the command carries its own options
	 * or its folder is new, which start a fresh session of their own.
	 */
	private restore(layout: SavedLayout): Entry {
		const isDirectory = this.options.isDirectory ?? defaultIsDirectory
		for (const saved of layout.spaces) {
			const space = this.roster.addSpace(saved.cwd, saved.name)
			const found = isDirectory(saved.cwd)
			if (saved.lastAccount) space.lastAccount = saved.lastAccount
			for (const savedTab of saved.tabs) this.restoreTab(space, savedTab, found)
			const active = saved.activeTab !== undefined ? space.tabs[saved.activeTab] : undefined
			space.activeTab = active ?? space.tabs[0]
		}
		const folder = this.roster.spaces.find((s) => s.cwd === this.options.folder.cwd)
		if (this.options.freshFirst || !folder) {
			const space =
				folder ?? this.roster.addSpace(this.options.folder.cwd, this.options.folder.name)
			const entry = this.newTabIn(space)
			entry.first = true
			return entry
		}
		const focused =
			layout.focus !== undefined
				? this.roster.spaces[layout.focus.space]?.activeTab?.focus
				: undefined
		return focused ?? folder.activeTab?.focus ?? this.newTabIn(folder)
	}

	private restoreTab(space: Space, saved: SavedTab, found: boolean): void {
		const build = (node: SavedNode): Node => {
			if (!('session' in node))
				return {
					kind: 'split',
					dir: node.split,
					ratio: node.ratio,
					a: build(node.a),
					b: build(node.b),
				}
			const item = node.session
			const entry = this.addEntry(space, item.label)
			if (item.conversationId) {
				entry.conversationId = item.conversationId
				entry.resume = item.conversationId
			}
			entry.verifyFolder = true
			entry.folderMissing = !found
			if (item.account) entry.account = item.account
			if (item.pickedAccount) entry.pickedAccount = item.pickedAccount
			return leaf(entry)
		}
		const root = build(saved.tree)
		const panes = leaves(root)
		this.roster.addTree(
			space,
			root,
			panes[saved.focus ?? 0] ?? (panes[0] as Entry),
			saved.name,
			saved.zoomed === true,
		)
	}

	private addEntry(space: Space, label?: string): Entry {
		const entry = this.roster.addSession(space, this.options.newSlot?.() ?? randomUUID(), label)
		this.persist()
		return entry
	}

	/** A session in a tab of its own, after the space's other tabs. */
	private newTabIn(space: Space): Entry {
		const entry = this.addEntry(space)
		this.roster.addTab(space, entry)
		return entry
	}

	private layout() {
		return computeLayout(this.options.output.columns, this.options.output.rows, this.sidebar)
	}

	/** The sidebar's view of the host: what it needs to draw and to find what a click lands on. */
	private sidebarModel(rail: boolean) {
		return {
			roster: this.roster,
			mode: this.router.current === 'navigate' ? ('navigate' as const) : ('terminal' as const),
			foot: [],
			scroll: this.sidebarScroll,
			palette: this.palette,
			git: (cwd: string) => this.git.get(cwd),
			order: this.order,
			split: this.split,
			rail,
		}
	}

	/** Where the shown tab's panes are. */
	private placement(): Placement | undefined {
		const tab = this.roster.shownTab
		return tab ? placeTab(tab, this.layout().panes) : undefined
	}

	/** What a session's terminal is given: its pane's inside, or the whole pane area for one that is not shown. */
	private paneSize(entry: Entry): { cols: number; rows: number } {
		const pane = this.placement()?.panes.find((p) => p.entry === entry)
		const rect = pane?.inner ?? this.layout().panes
		return { cols: Math.max(1, rect.width), rows: Math.max(1, rect.height) }
	}

	/** Gives each pane's terminal the size of its pane. */
	private fit(): void {
		for (const pane of this.placement()?.panes ?? [])
			pane.entry.child?.resize(Math.max(1, pane.inner.width), Math.max(1, pane.inner.height))
	}

	/** Starts the entry's terminal if it has none yet. */
	private ensureStarted(entry: Entry): void {
		if (entry.child || this.closed || entry.checking) return
		if (entry.verifyFolder) {
			const found = (this.options.isDirectory ?? defaultIsDirectory)(this.roster.spaceOf(entry).cwd)
			if (entry.folderMissing === found) {
				entry.folderMissing = !found
				this.requestRender()
			}
			if (!found) return
		}
		const guard = this.options.inUseElsewhere
		if (entry.resume && guard) {
			// A conversation open in another terminal is never given a second writer.
			entry.checking = true
			const space = this.roster.spaceOf(entry)
			void guard({ cwd: space.cwd, conversationId: entry.resume })
				.catch(() => false)
				.then((busy) => {
					entry.checking = false
					if (this.closed || !this.roster.entries.includes(entry)) return
					entry.openElsewhere = busy
					if (!busy) this.spawn(entry)
					this.requestRender()
				})
			this.requestRender()
			return
		}
		this.spawn(entry)
	}

	private spawn(entry: Entry): void {
		if (entry.child || this.closed) return
		const space = this.roster.spaceOf(entry)
		const spec = this.options.spec({
			cwd: space.cwd,
			slot: entry.slot,
			first: entry.first,
			...(entry.pickedAccount ? { account: entry.pickedAccount } : {}),
			...(entry.account ? { accountLabel: entry.account } : {}),
			...(entry.resume ? { resume: entry.resume } : {}),
		})
		entry.first = false
		entry.resume = undefined
		const child = new ChildSession(
			entry.label,
			spec,
			this.paneSize(entry),
			() => this.childChanged(entry),
			this.options.kill,
		)
		entry.child = child
		child.start(this.options.binding)
		this.roster.update(entry)
	}

	/** Shows a session and starts the panes of its tab that have not been opened before. */
	private open(entry: Entry): void {
		this.show(entry)
		const tab = this.roster.tabOf(entry)
		for (const pane of tab ? leaves(tab.root) : [entry]) this.ensureStarted(pane)
		this.router.focus()
		this.requestRender()
	}

	/** Shows a session without starting it. */
	private show(entry: Entry): void {
		this.roster.select(entry)
		if (this.gitStarted) this.git.refresh(this.roster.spaceOf(entry).cwd, GIT_STALE_MS)
		this.fit()
		this.revealSelected()
		this.persist()
	}

	private childChanged(entry: Entry): void {
		this.roster.update(entry)
		for (let i = this.leaving.length - 1; i >= 0; i--) {
			const gone = this.leaving[i]
			if (gone?.status === 'exited') {
				gone.dispose()
				this.leaving.splice(i, 1)
			}
		}
		if (this.quitting && this.everyChild().every((c) => c.status === 'exited')) this.close()
		else this.requestRender()
	}

	private everyChild(): ChildSession[] {
		const own = this.roster.entries.flatMap((e) => (e.child ? [e.child] : []))
		return [...own, ...this.leaving]
	}

	private relayout(): void {
		if (this.closed) return
		this.fit()
		this.writer.invalidate()
		this.requestRender()
	}

	// --- status feed -----------------------------------------------------------

	private armPoll(): void {
		if (!this.options.peers || this.closed) return
		this.cancelPoll = this.schedule(() => {
			this.readStatus()
			this.armPoll()
		}, POLL_MS)
	}

	private armReconcile(): void {
		if (!this.options.peers || this.closed) return
		this.cancelReconcile = this.schedule(() => {
			void this.reconcile().finally(() => this.armReconcile())
		}, RECONCILE_MS)
	}

	/** Takes what each session's terminal last wrote about itself. */
	readStatus(): void {
		const peers = this.options.peers
		if (!peers || this.closed) return
		let records: ReturnType<PeerSource['records']>
		try {
			records = peers.records()
		} catch {
			return
		}
		let changed = false
		for (const entry of this.roster.entries) {
			if (!entry.child || entry.child.status === 'exited') continue
			const record = recordForSlot(records, entry.slot, entry.child.pid)
			if (!record) continue
			if (entry.reported !== record.state) changed = true
			entry.reported = record.state
			if (entry.account !== record.account) {
				changed = true
				this.rememberAccount(entry, record.account)
			}
			entry.account = record.account
			if (entry.limited !== (record.limited === true)) changed = true
			entry.limited = record.limited === true
			entry.limitedUntil = record.limited === true ? record.limitedUntil : undefined
			if (record.conversationId && entry.conversationId !== record.conversationId) {
				entry.conversationId = record.conversationId
				this.persist()
			}
			this.roster.update(entry)
		}
		if (changed) {
			this.persist()
			this.requestRender()
		}
	}

	/** A session that moved to another account makes that account the one its space offers first. */
	private rememberAccount(entry: Entry, label: string | undefined): void {
		const space = this.roster.spaceOf(entry)
		const matches = (this.options.accounts?.() ?? []).filter((a) => a.label === label)
		const found = label !== undefined && matches.length === 1 ? matches[0] : undefined
		// What a not-yet-conversing session would start on follows what it now runs on.
		entry.pickedAccount = found?.id
		if (label === undefined) delete space.lastAccount
		else if (found) space.lastAccount = found.id
	}

	/** Asks each terminal its state directly, so a change that was never written is still seen. */
	async reconcile(): Promise<void> {
		const peers = this.options.peers
		if (!peers || this.closed || this.reconciling) return
		this.reconciling = true
		try {
			let records: ReturnType<PeerSource['records']>
			try {
				records = peers.records()
			} catch {
				return
			}
			const asks = this.roster.entries.flatMap((entry) => {
				if (!entry.child || entry.child.status === 'exited') return []
				const record = recordForSlot(records, entry.slot, entry.child.pid)
				return record ? [{ entry, record }] : []
			})
			await Promise.all(
				asks.map(async ({ entry, record }) => {
					const state = await peers.ping(record)
					if (state === undefined || this.closed) return
					if (!this.roster.entries.includes(entry) || entry.reported === state) return
					entry.reported = state
					this.roster.update(entry)
					this.requestRender()
				}),
			)
		} finally {
			this.reconciling = false
		}
	}

	// --- input -----------------------------------------------------------------

	/** Called with what the keyboard sent. */
	handleInput(chunk: string): void {
		if (this.closed) return
		for (const action of this.router.feed(chunk)) {
			if (action.type === 'write') this.writeToSelected(action.data)
			else if (action.type === 'mode') {
				if (action.mode === 'terminal' && !this.captured()) this.startShown()
				this.requestRender()
			} else if (action.type === 'mouse') this.mouse(action.mouse)
			else this.key(action.from, action.key)
		}
	}

	/** Starts the panes of the shown tab that have not been opened before. */
	private startShown(): void {
		const tab = this.roster.shownTab
		for (const pane of tab ? leaves(tab.root) : []) this.ensureStarted(pane)
	}

	private writeToSelected(data: string): void {
		const entry = this.roster.selected
		if (!entry) return
		this.ensureStarted(entry)
		entry.scrollBack = 0
		entry.child?.write(data)
	}

	/** A key the host reads: an answer, a name being typed, a mode's key, or the key after the prefix. */
	private key(from: KeyContext, key: NavKey): void {
		this.notice = undefined
		if (this.context) this.contextKey(key)
		else if (this.menu) this.menuKey(key)
		else if (this.help) this.helpKey(key)
		else if (this.accountList) this.accountsKey(key)
		else if (this.goto) this.gotoKey(key)
		else if (this.picker) this.pickerKey(key)
		else if (this.prompt) this.promptKey(key)
		else if (this.confirm) this.confirmKey(key)
		else if (from === 'prefix') this.command(key)
		else if (from === 'resize') this.resizeKey(key)
		else if (from === 'navigate') this.navigateKey(key)
		this.router.capture(this.captured())
		this.requestRender()
	}

	/** The key after the prefix: whatever the key map binds it to. */
	private command(key: NavKey): void {
		const binding = bindingFor(key)
		if (binding) this.run(binding.action, key)
	}

	private run(action: ActionId, key?: NavKey): void {
		const entry = this.roster.selected
		if (!entry) return
		switch (action) {
			case 'help':
				this.help = { scroll: 0 }
				return
			case 'menu':
				this.openMenu()
				return
			case 'goto': {
				const rows = gotoRows(this.roster)
				this.goto = { query: '', index: currentRow(rows, entry), scroll: 0 }
				return
			}
			case 'quit':
				this.askQuit()
				return
			case 'new-space':
				this.prompt = { kind: 'new-space', value: this.roster.spaceOf(entry).cwd }
				return
			case 'open-folder':
				this.askFolder()
				return
			case 'rename-space':
				this.askName('rename-space', this.roster.spaceOf(entry).name)
				return
			case 'close-space':
				this.confirm = 'close-space'
				return
			// The router starts these two modes itself; there is nothing more to do.
			case 'space-mode':
			case 'resize-mode':
				return
			case 'sidebar':
				this.toggleSidebar()
				return
			case 'new-tab':
				this.newTab()
				return
			case 'rename-tab':
				this.askName('rename-tab', this.shownTabLabel())
				return
			case 'close-tab':
				this.closeTab()
				return
			case 'prev-tab':
				this.stepTab(-1)
				return
			case 'next-tab':
				this.stepTab(1)
				return
			case 'tab-number':
				if (key?.kind === 'char') this.gotoTab(Number(key.char) - 1)
				return
			case 'split-side':
				this.splitFocused('side')
				return
			case 'split-stack':
				this.splitFocused('stack')
				return
			case 'focus-left':
				this.moveFocus('left')
				return
			case 'focus-down':
				this.moveFocus('down')
				return
			case 'focus-up':
				this.moveFocus('up')
				return
			case 'focus-right':
				this.moveFocus('right')
				return
			case 'swap-left':
				this.swapFocused('left')
				return
			case 'swap-down':
				this.swapFocused('down')
				return
			case 'swap-up':
				this.swapFocused('up')
				return
			case 'swap-right':
				this.swapFocused('right')
				return
			case 'next-pane':
				this.cyclePane(1)
				return
			case 'prev-pane':
				this.cyclePane(-1)
				return
			case 'close-pane':
				this.closePane()
				return
			case 'zoom':
				this.toggleZoom()
				return
			case 'rename-pane':
				this.askName('rename-session', entry.label)
				return
			default: {
				// Adding an action without a case here is a type error.
				const unhandled: never = action
				void unhandled
			}
		}
	}

	/** The name the shown tab was given; a tab without one has none to edit. */
	private shownTabLabel(): string {
		return this.roster.shownTab?.name ?? ''
	}

	private askQuit(): void {
		if (this.everyChild().every((s) => s.status === 'exited')) this.quit()
		else this.confirm = 'quit'
	}

	private toggleSidebar(): void {
		this.sidebar = { ...this.sidebar, collapsed: !this.sidebar.collapsed }
		this.relayout()
		this.persist()
	}

	/** A space in the focused pane's folder, started on the same account. */
	private newSpaceHere(): void {
		const entry = this.roster.selected
		const cwd = entry ? this.roster.spaceOf(entry).cwd : this.options.folder.cwd
		this.newSpaceIn(cwd)
	}

	/** A new space in a folder, its first session on the account the focused pane runs on. */
	private newSpaceIn(cwd: string): void {
		const entry = this.roster.selected
		const space = this.roster.addSpace(cwd, basename(cwd) || cwd)
		const created = this.newTabIn(space)
		if (entry?.pickedAccount) created.pickedAccount = entry.pickedAccount
		this.open(created)
	}

	private captured(): boolean {
		return (
			this.prompt !== undefined ||
			this.picker !== undefined ||
			this.confirm !== undefined ||
			this.menu !== undefined ||
			this.help !== undefined ||
			this.goto !== undefined ||
			this.accountList !== undefined ||
			this.context !== undefined
		)
	}

	/** Closes whatever overlay is open without doing what it asked. */
	private dismiss(): void {
		this.prompt = undefined
		this.picker = undefined
		this.confirm = undefined
		this.menu = undefined
		this.help = undefined
		this.goto = undefined
		this.accountList = undefined
		this.context = undefined
		this.router.capture(false)
	}

	private openMenu(): void {
		this.menu = { index: 0 }
		this.router.capture(true)
	}

	private chooseMenu(index: number): void {
		this.menu = undefined
		const item = MENU_ITEMS[index]
		if (item === 'keybinds') this.help = { scroll: 0 }
		else if (item === 'accounts') this.accountList = { scroll: 0 }
		else if (item === 'add account') this.addAccount()
		else if (item === 'sidebar') this.toggleSidebar()
		else this.askQuit()
		this.router.capture(this.captured())
	}

	/** A session in a new tab on the usual sign-in, where the `/auth` command adds the account. */
	private addAccount(): void {
		const entry = this.roster.selected
		if (!entry) return
		this.startIn(this.roster.spaceOf(entry), undefined, false)
		this.notice = 'Type /auth in this session to add an account.'
	}

	private menuKey(key: NavKey): void {
		const menu = this.menu
		if (!menu) return
		const last = MENU_ITEMS.length - 1
		if (key.kind === 'escape') this.menu = undefined
		else if (key.kind === 'up' || (key.kind === 'char' && key.char === 'k'))
			menu.index = Math.max(0, menu.index - 1)
		else if (key.kind === 'down' || (key.kind === 'char' && key.char === 'j'))
			menu.index = Math.min(last, menu.index + 1)
		else if (key.kind === 'enter') this.chooseMenu(menu.index)
	}

	private helpKey(key: NavKey): void {
		const help = this.help
		if (!help) return
		const page = this.helpLayout()?.capacity ?? 10
		if (key.kind === 'up' || (key.kind === 'char' && key.char === 'k'))
			help.scroll = Math.max(0, help.scroll - 1)
		else if (key.kind === 'down' || (key.kind === 'char' && key.char === 'j')) help.scroll += 1
		else if (key.kind === 'tab') help.scroll += page
		else if (key.kind === 'backtab') help.scroll = Math.max(0, help.scroll - page)
		else if (
			key.kind === 'escape' ||
			key.kind === 'enter' ||
			(key.kind === 'char' && (key.char === '?' || key.char === 'q'))
		)
			this.help = undefined
		const layout = this.helpLayout()
		if (this.help && layout) this.help.scroll = layout.top
	}

	private accountsKey(key: NavKey): void {
		const list = this.accountList
		if (!list) return
		if (key.kind === 'up' || (key.kind === 'char' && key.char === 'k'))
			list.scroll = Math.max(0, list.scroll - 1)
		else if (key.kind === 'down' || (key.kind === 'char' && key.char === 'j')) list.scroll += 1
		else if (key.kind === 'enter' || key.kind === 'escape') this.accountList = undefined
		const layout = this.accountsLayout()
		if (this.accountList && layout) this.accountList.scroll = layout.top
	}

	private gotoKey(key: NavKey): void {
		const goto = this.goto
		if (!goto) return
		const rows = this.gotoVisible()
		const last = rows.length - 1
		if (key.kind === 'escape') this.goto = undefined
		else if (key.kind === 'up' || key.kind === 'backtab') goto.index = Math.max(0, goto.index - 1)
		else if (key.kind === 'down' || key.kind === 'tab') goto.index = Math.min(last, goto.index + 1)
		else if (key.kind === 'enter') this.chooseGoto(rows[goto.index])
		else if (key.kind === 'backspace') {
			goto.query = goto.query.slice(0, -1)
			goto.index = 0
		} else if (key.kind === 'char') {
			if (key.char === CLEAR) goto.query = ''
			else goto.query += key.char
			goto.index = 0
		}
		const layout = this.gotoLayout()
		if (this.goto && layout) this.goto.scroll = layout.top
	}

	/** Focuses what a row of the go-to tree names. */
	private chooseGoto(row: GotoRow | undefined): void {
		this.goto = undefined
		this.router.capture(false)
		if (!row) return
		const { target } = row
		if (target.kind === 'pane') this.open(target.entry)
		else if (target.kind === 'tab') this.open(target.tab.focus)
		else {
			const entry = target.space.activeTab?.focus ?? this.roster.entriesOf(target.space)[0]
			if (entry) this.open(entry)
		}
	}

	private confirmKey(key: NavKey): void {
		const confirmed = this.confirm
		if (!confirmed) return
		this.confirm = undefined
		if (key.kind === 'enter' || (key.kind === 'char' && key.char === 'y')) this.perform(confirmed)
	}

	private contextKey(key: NavKey): void {
		const context = this.context
		if (!context) return
		const items = CONTEXT_ITEMS[context.target.kind]
		if (key.kind === 'escape') this.context = undefined
		else if (key.kind === 'up' || (key.kind === 'char' && key.char === 'k'))
			context.index = Math.max(0, context.index - 1)
		else if (key.kind === 'down' || (key.kind === 'char' && key.char === 'j'))
			context.index = Math.min(items.length - 1, context.index + 1)
		else if (key.kind === 'enter') this.chooseContext(context.index)
	}

	/** Shows what a right-click was on, then does the chosen item to it. */
	private chooseContext(index: number): void {
		const context = this.context
		this.context = undefined
		if (!context) return
		const item = CONTEXT_ITEMS[context.target.kind][index]
		const { target } = context
		const entry =
			target.kind === 'pane'
				? target.entry
				: target.kind === 'tab'
					? target.tab.focus
					: (target.space.activeTab?.focus ?? this.roster.entriesOf(target.space)[0])
		if (!entry || !item) return
		this.show(entry)
		const shown = this.roster.spaceOf(entry)
		if (item === 'Rename') {
			if (target.kind === 'space') this.askName('rename-space', shown.name)
			else if (target.kind === 'tab') this.askName('rename-tab', this.shownTabLabel())
			else this.askName('rename-session', entry.label)
		} else if (item === 'New tab') this.newTab()
		else if (item === 'Split right') this.splitFocused('side')
		else if (item === 'Split down') this.splitFocused('stack')
		else if (item === 'Zoom') this.toggleZoom()
		else if (target.kind === 'space') this.confirm = 'close-space'
		else if (target.kind === 'tab') this.closeTabOrSpace()
		else this.closePane()
		this.router.capture(this.captured())
	}

	private resizeKey(key: NavKey): void {
		const entry = this.roster.selected
		const tab = this.roster.shownTab
		if (!entry || !tab) return
		let axis: SplitDir | undefined
		let forward = false
		const c = key.kind === 'char' ? key.char : ''
		if (c === 'h' || key.kind === 'left') [axis, forward] = ['side', false]
		else if (c === 'l' || key.kind === 'right') [axis, forward] = ['side', true]
		else if (c === 'j' || key.kind === 'down') [axis, forward] = ['stack', true]
		else if (c === 'k' || key.kind === 'up') [axis, forward] = ['stack', false]
		if (axis && resizeAt(tab.root, entry, axis, forward)) {
			this.fit()
			this.persist()
		}
	}

	private navigateKey(key: NavKey): void {
		const c = key.kind === 'char' ? key.char : ''
		if (key.kind === 'up' || c === 'k') this.stepSpace(-1)
		else if (key.kind === 'down' || c === 'j') this.stepSpace(1)
		else if (key.kind === 'tab') this.cyclePane(1)
		else if (key.kind === 'backtab') this.cyclePane(-1)
	}

	// --- panes and tabs --------------------------------------------------------

	/** The shown tab's panes as they would sit with nothing zoomed, which is what a direction is measured on. */
	private flatPanes() {
		const tab = this.roster.shownTab
		return tab ? placeTab({ ...tab, zoomed: false }, this.layout().panes).panes : []
	}

	/** Splits the focused pane; the new pane is a session in the same folder, on the same account. */
	private splitFocused(dir: SplitDir): void {
		const entry = this.roster.selected
		const tab = this.roster.shownTab
		if (!entry || !tab) return
		const outer = this.flatPanes().find((p) => p.entry === entry)?.outer
		const room = dir === 'side' ? (outer?.width ?? 0) : (outer?.height ?? 0)
		const least = dir === 'side' ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT
		if (room < least * 2) {
			this.notice = 'There is not enough room to split this pane.'
			return
		}
		const created = this.addEntry(this.roster.spaceOf(entry))
		if (entry.pickedAccount) created.pickedAccount = entry.pickedAccount
		this.roster.splitBeside(entry, created, dir)
		this.open(created)
	}

	private moveFocus(direction: Direction): void {
		const entry = this.roster.selected
		if (!entry) return
		const target = neighbour(this.flatPanes(), entry, direction)
		if (target) this.open(target)
	}

	private swapFocused(direction: Direction): void {
		const entry = this.roster.selected
		const tab = this.roster.shownTab
		if (!entry || !tab) return
		const target = neighbour(this.flatPanes(), entry, direction)
		if (!target) return
		swapLeaves(tab.root, entry, target)
		this.fit()
		this.persist()
	}

	private cyclePane(delta: number): void {
		const entry = this.roster.selected
		const tab = this.roster.shownTab
		if (!entry || !tab) return
		const panes = leaves(tab.root)
		const next = panes[(panes.indexOf(entry) + delta + panes.length) % panes.length]
		if (next && next !== entry) this.open(next)
	}

	private toggleZoom(): void {
		const tab = this.roster.shownTab
		if (!tab || leaves(tab.root).length < 2) return
		tab.zoomed = !tab.zoomed
		this.fit()
		this.persist()
	}

	private stepTab(delta: number): void {
		const entry = this.roster.selected
		if (!entry) return
		const space = this.roster.spaceOf(entry)
		const at = space.activeTab ? space.tabs.indexOf(space.activeTab) : 0
		this.gotoTab((at + delta + space.tabs.length) % space.tabs.length)
	}

	private gotoTab(index: number): void {
		const entry = this.roster.selected
		if (!entry) return
		const tab = this.roster.spaceOf(entry).tabs[index]
		if (tab) this.open(tab.focus)
	}

	/** Closes the focused pane; the last pane of a tab closes the tab, and of a space's only tab asks to close the space. */
	private closePane(): void {
		const entry = this.roster.selected
		const tab = this.roster.shownTab
		if (!entry || !tab) return
		if (leaves(tab.root).length > 1 || this.roster.spaceOf(entry).tabs.length > 1) {
			this.closeEntries([entry])
			return
		}
		this.confirm = 'close-space'
	}

	/** Closes a tab; a space's only tab closes the space, after asking. */
	private closeTabOrSpace(): void {
		const entry = this.roster.selected
		if (entry && this.roster.spaceOf(entry).tabs.length > 1) this.closeTab()
		else this.confirm = 'close-space'
	}

	private closeTab(): void {
		const entry = this.roster.selected
		const tab = this.roster.shownTab
		if (!entry || !tab) return
		if (this.roster.spaceOf(entry).tabs.length <= 1) {
			this.notice = 'A space keeps at least one tab.'
			return
		}
		this.closeEntries(leaves(tab.root))
	}

	/** Starts a session in a new tab of the shown space, asking which account first when there is a choice. */
	private newTab(): void {
		const entry = this.roster.selected
		if (!entry) return
		const space = this.roster.spaceOf(entry)
		let accounts: readonly HostAccount[] = []
		try {
			accounts = (this.options.accounts?.() ?? []).filter((a) => a.label !== 'default')
		} catch {
			accounts = []
		}
		if (accounts.length === 0) {
			this.startIn(space, undefined)
			return
		}
		const choices = [
			{ id: undefined, text: 'Usual sign-in' },
			...accounts.map((a) => ({
				id: a.id as string | undefined,
				text: `${a.label}  ${a.provider}`,
			})),
		]
		const remembered = choices.findIndex((c) => c.id !== undefined && c.id === space.lastAccount)
		this.picker = { space, choices, index: Math.max(0, remembered) }
	}

	private startIn(space: Space, account: string | undefined, ask = true): void {
		if (account === undefined) delete space.lastAccount
		else space.lastAccount = account
		const created = this.newTabIn(space)
		if (account !== undefined) created.pickedAccount = account
		this.open(created)
		// A new tab asks for its name; leaving it empty keeps the number.
		if (ask) {
			this.prompt = { kind: 'rename-tab', value: '', fresh: true }
			this.router.capture(true)
		}
	}

	/** Moves among the spaces, showing each one's tab without starting what it holds. */
	private stepSpace(delta: number): void {
		const entry = this.roster.selected
		if (!entry) return
		const index = this.roster.spaces.indexOf(this.roster.spaceOf(entry)) + delta
		const space = this.roster.spaces[index]
		const target = space?.activeTab?.focus
		if (target) this.show(target)
	}

	private gotoSpace(index: number): void {
		const target = this.roster.spaces[index]?.activeTab?.focus
		if (target) this.show(target)
	}

	private pickerKey(key: NavKey): void {
		const picker = this.picker
		if (!picker) return
		const last = picker.choices.length - 1
		if (key.kind === 'escape') this.picker = undefined
		else if (key.kind === 'up' || (key.kind === 'char' && key.char === 'k'))
			picker.index = Math.max(0, picker.index - 1)
		else if (key.kind === 'down' || (key.kind === 'char' && key.char === 'j'))
			picker.index = Math.min(last, picker.index + 1)
		else if (key.kind === 'enter') {
			this.picker = undefined
			this.router.capture(false)
			this.startIn(picker.space, picker.choices[picker.index]?.id)
		}
	}

	private askFolder(): void {
		this.prompt = { kind: 'folder', value: '' }
	}

	private askName(kind: 'rename-session' | 'rename-space' | 'rename-tab', value: string): void {
		this.prompt = { kind, value }
	}

	private promptKey(key: NavKey): void {
		const prompt = this.prompt
		if (!prompt) return
		if (key.kind === 'escape') {
			this.endPrompt()
			return
		}
		if (key.kind === 'backspace') {
			prompt.value = prompt.value.slice(0, -1)
			delete prompt.error
			return
		}
		if (key.kind === 'char') {
			if (key.char === CLEAR) prompt.value = ''
			else prompt.value += key.char
			delete prompt.error
			return
		}
		if (key.kind !== 'enter') return
		const value = prompt.value.trim()
		if (prompt.kind === 'folder' || prompt.kind === 'new-space') {
			if (value === '') {
				this.endPrompt()
				return
			}
			const path = this.expand(value)
			if (!(this.options.isDirectory ?? defaultIsDirectory)(path)) {
				prompt.error = 'No such folder.'
				return
			}
			this.endPrompt()
			if (prompt.kind === 'new-space') this.newSpaceIn(path)
			else this.openFolder(path)
			return
		}
		const entry = this.roster.selected
		const tab = this.roster.shownTab
		if (entry) {
			if (prompt.kind === 'rename-session' && value !== '') entry.label = value
			else if (prompt.kind === 'rename-space' && value !== '')
				this.roster.spaceOf(entry).name = value
			// An empty tab name goes back to the tab's number.
			else if (prompt.kind === 'rename-tab' && tab) {
				if (value === '') delete tab.name
				else tab.name = value
			}
			this.persist()
		}
		this.endPrompt()
	}

	private endPrompt(): void {
		this.prompt = undefined
		this.router.capture(false)
	}

	private expand(value: string): string {
		const home = this.options.homeDirectory ?? homedir()
		const full = value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value
		const base = this.roster.selected
			? this.roster.spaceOf(this.roster.selected).cwd
			: this.options.folder.cwd
		return isAbsolute(full) ? resolve(full) : resolve(base, full)
	}

	/** Opens a folder as a space, or shows the space it already is. */
	private openFolder(path: string): void {
		const known = this.roster.spaces.find((s) => s.cwd === path)
		if (known) {
			const entry = known.activeTab?.focus ?? this.roster.entriesOf(known)[0]
			if (entry) this.open(entry)
			return
		}
		const space = this.roster.addSpace(path, basename(path) || path)
		this.open(this.newTabIn(space))
	}

	private perform(what: Confirm): void {
		const entry = this.roster.selected
		if (what === 'quit') {
			this.quit()
			return
		}
		if (!entry) return
		this.closeEntries(this.roster.entriesOf(this.roster.spaceOf(entry)))
	}

	/** Ends the sessions and takes their panes away; closing the last one leaves nothing to bring back and quits. */
	private closeEntries(doomed: readonly Entry[]): void {
		if (doomed.length === this.roster.entries.length) {
			this.forgetAll = true
			this.quit()
			return
		}
		for (const item of doomed) {
			if (item.child && item.child.status !== 'exited') {
				this.leaving.push(item.child)
				item.child.stop('SIGHUP')
			} else item.child?.dispose()
			this.roster.removeEntry(item)
		}
		this.persist()
		const next = this.roster.selected
		if (next) this.show(next)
	}

	// --- mouse -----------------------------------------------------------------

	private mouse(event: MouseEvent): void {
		if (event.kind === 'release') this.endDrags()
		if (this.captured()) {
			this.overlayMouse(event)
			return
		}
		const layout = this.layout()
		const inSidebar = layout.sidebar !== undefined && event.x < layout.sidebar.width
		if (event.kind === 'wheel-up' || event.kind === 'wheel-down') {
			const direction = event.kind === 'wheel-up' ? -1 : 1
			if (inSidebar && layout.sidebar) {
				const model = this.sidebarModel(layout.rail)
				const region = regionAt(model, layout.sidebar.height, event.y)
				if (region)
					this.sidebarScroll = clampScroll(
						{
							...this.sidebarScroll,
							[region]: this.sidebarScroll[region] + direction * WHEEL_ROWS,
						},
						model,
						layout.sidebar.height,
					)
			} else {
				// The pane under the pointer scrolls, whether or not it has focus.
				const entry = this.placement()?.panes.find(
					(p) => paneAt([p], event.x, event.y) !== undefined,
				)?.entry
				const size = entry?.child?.screen.scrollbackSize() ?? 0
				if (entry)
					entry.scrollBack = Math.max(0, Math.min(size, entry.scrollBack - direction * WHEEL_ROWS))
			}
			this.requestRender()
			return
		}
		if (event.kind === 'drag') {
			if (this.reorder) this.dragSpace(layout, event)
			else if (this.sidebarDrag) this.dragSidebar(event)
			else this.dragBorder(event)
			return
		}
		if (event.kind === 'release') return
		if (event.kind === 'context') {
			this.openContext(layout, event)
			return
		}
		if (event.kind !== 'press') return
		if (inSidebar && layout.sidebar) {
			this.sidebarPress(layout.sidebar, layout.rail, event)
			return
		}
		if (layout.rule && event.x === layout.rule.x) {
			this.edgePress(layout.rail)
			return
		}
		if (this.router.current !== 'terminal') this.router.focus()
		this.workspacePress(event)
		this.requestRender()
	}

	/** A press on the line between the sidebar and the session: a second one soon after resets the width. */
	private edgePress(rail: boolean): void {
		if (rail) return
		const at = (this.options.now ?? Date.now)()
		if (this.lastEdgePress !== undefined && at - this.lastEdgePress <= DOUBLE_CLICK_MS) {
			this.lastEdgePress = undefined
			this.sidebar = { ...this.sidebar, width: SIDEBAR_DEFAULT }
			this.relayout()
			this.persist()
			return
		}
		this.lastEdgePress = at
		this.sidebarDrag = 'width'
	}

	/** Moves the sidebar's edge, or the rule between its sections, to follow the pointer. */
	private dragSidebar(event: MouseEvent): void {
		if (this.sidebarDrag === 'width') {
			const width = clampSidebarWidth(event.x + 1)
			if (width === this.sidebar.width) return
			this.sidebar = { ...this.sidebar, width }
			this.relayout()
			return
		}
		const height = this.options.output.rows
		const split = Math.max(0.1, Math.min(0.9, event.y / height))
		this.split = ruleRow(height, split) / height
		this.requestRender()
	}

	private sidebarPress(sidebar: Rect, rail: boolean, event: MouseEvent): void {
		const target = hitTest(this.sidebarModel(rail), sidebar.width, sidebar.height, event.x, event.y)
		if (target?.kind === 'agent') this.open(target.entry)
		else if (target?.kind === 'space') {
			this.reorder = { space: target.space, to: this.roster.spaces.indexOf(target.space) }
			this.gotoSpace(this.roster.spaces.indexOf(target.space))
			const shown = this.roster.selected
			if (shown) this.open(shown)
		} else if (target?.kind === 'new') this.newSpaceHere()
		else if (target?.kind === 'menu') this.openMenu()
		else if (target?.kind === 'collapse') this.toggleSidebar()
		else if (target?.kind === 'split') this.sidebarDrag = 'split'
		else if (target?.kind === 'order') {
			this.order = this.order === 'grouped' ? 'priority' : 'grouped'
			this.sidebarScroll = { ...this.sidebarScroll, agents: 0 }
			this.persist()
		}
		this.requestRender()
	}

	/** A pointer button went up: a drag of a border, the sidebar or a space ends, and a moved space lands. */
	private endDrags(): void {
		const moved = this.reorder
		if (moved && this.roster.moveSpace(moved.space, moved.to)) {
			this.revealSelected()
			this.persist()
		}
		if (this.drag || this.sidebarDrag) this.persist()
		this.reorder = undefined
		this.drag = undefined
		this.sidebarDrag = undefined
		this.requestRender()
	}

	/** While a space is dragged: the place it would land is the space row under the pointer. */
	private dragSpace(layout: Layout, event: MouseEvent): void {
		const drag = this.reorder
		if (!drag || !layout.sidebar) return
		const target = hitTest(
			this.sidebarModel(layout.rail),
			layout.sidebar.width,
			layout.sidebar.height,
			Math.min(event.x, layout.sidebar.width - 1),
			event.y,
		)
		if (target?.kind === 'space') drag.to = this.roster.spaces.indexOf(target.space)
		else if (!target) {
			// Blank sidebar area under the last space row: the space goes to the end.
			const geo = geometry(
				layout.sidebar.height,
				this.sidebarModel(layout.rail).foot.length,
				this.split,
				layout.rail,
			)
			const shown = this.roster.spaces.length - this.sidebarScroll.spaces
			if (event.y >= geo.spaceTop + shown * geo.spaceStep && event.y < (geo.footerY ?? geo.ruleY))
				drag.to = this.roster.spaces.length - 1
		}
		this.requestRender()
	}

	/** A right-click: a menu for the space, tab or pane under the pointer. */
	private openContext(layout: Layout, event: MouseEvent): void {
		let target: ContextTarget | undefined
		if (layout.sidebar && event.x < layout.sidebar.width) {
			const hit = hitTest(
				this.sidebarModel(layout.rail),
				layout.sidebar.width,
				layout.sidebar.height,
				event.x,
				event.y,
			)
			if (hit?.kind === 'space') target = { kind: 'space', space: hit.space }
			else if (hit?.kind === 'agent') target = { kind: 'pane', entry: hit.entry }
		} else if (event.y === layout.tabBar.y) {
			const entry = this.roster.selected
			const hit = entry
				? tabBarTarget(layoutTabBar(this.roster.spaceOf(entry), layout.tabBar), event.x, event.y)
				: undefined
			if (hit?.kind === 'tab') target = { kind: 'tab', tab: hit.tab }
		} else {
			const placement = this.placement()
			const pane = placement ? paneAt(placement.panes, event.x, event.y) : undefined
			if (pane) target = { kind: 'pane', entry: pane.entry }
		}
		if (!target) return
		this.context = { target, at: { x: event.x, y: event.y }, index: 0 }
		this.router.capture(true)
		this.requestRender()
	}

	private screen(): Screen {
		return { cols: this.options.output.columns, rows: this.options.output.rows }
	}

	/** Where the open overlay is, for finding what a press lands on. */
	private overlaySurface(): Surface | undefined {
		const screen = this.screen()
		if (this.context)
			return layoutPopup(screen, this.context.at, CONTEXT_ITEMS[this.context.target.kind])
		if (this.menu) return this.menuSurface()
		const modal = this.modalSpec()
		if (modal) return layoutModal(screen, modal)
		return this.listLayout()
	}

	private listSpec(): ListSpec | undefined {
		if (this.picker) return this.pickerSpec(this.picker)
		if (this.help) return this.helpSpec(this.help)
		if (this.goto) return this.gotoSpec(this.goto)
		if (this.accountList) return this.accountsSpec(this.accountList)
		return undefined
	}

	private listLayout() {
		const spec = this.listSpec()
		return spec ? layoutList(this.screen(), spec) : undefined
	}

	private helpLayout() {
		return this.help ? layoutList(this.screen(), this.helpSpec(this.help)) : undefined
	}

	private accountsLayout() {
		return this.accountList
			? layoutList(this.screen(), this.accountsSpec(this.accountList))
			: undefined
	}

	private gotoLayout() {
		return this.goto ? layoutList(this.screen(), this.gotoSpec(this.goto)) : undefined
	}

	private gotoVisible(): GotoRow[] {
		return this.goto ? filterGoto(gotoRows(this.roster), this.goto.query) : []
	}

	/** While an overlay is open a press picks inside it, and anywhere else closes it. */
	private overlayMouse(event: MouseEvent): void {
		if (event.kind === 'wheel-up' || event.kind === 'wheel-down') {
			const step = event.kind === 'wheel-up' ? -1 : 1
			if (this.help) this.help.scroll = Math.max(0, this.help.scroll + step * WHEEL_ROWS)
			else if (this.accountList)
				this.accountList.scroll = Math.max(0, this.accountList.scroll + step * WHEEL_ROWS)
			else if (this.goto) {
				const last = Math.max(0, this.gotoVisible().length - 1)
				this.goto.index = Math.max(0, Math.min(last, this.goto.index + step))
			}
			this.requestRender()
			return
		}
		if (event.kind !== 'press' && event.kind !== 'context') return
		const surface = this.overlaySurface()
		const hit: Hit = surface ? hitSurface(surface, event.x, event.y) : { kind: 'outside' }
		if (hit.kind === 'outside') this.dismiss()
		else if (event.kind === 'press') this.pressOverlay(hit)
		this.router.capture(this.captured())
		this.requestRender()
	}

	private pressOverlay(hit: Hit): void {
		if (this.context && hit.kind === 'row') this.chooseContext(hit.index)
		else if (this.menu && hit.kind === 'row') this.chooseMenu(hit.index)
		else if (this.goto && hit.kind === 'row') {
			this.goto.index = hit.index
			this.chooseGoto(this.gotoVisible()[hit.index])
		} else if (this.picker && hit.kind === 'row') {
			this.picker.index = hit.index
			this.pickerKey({ kind: 'enter' })
		} else if (this.prompt && hit.kind === 'button') {
			if (hit.action === 'confirm') this.promptKey({ kind: 'enter' })
			else if (hit.action === 'clear') this.promptKey({ kind: 'char', char: CLEAR })
			else this.dismiss()
		} else if (this.confirm && hit.kind === 'button') {
			if (hit.action === 'confirm') this.confirmKey({ kind: 'enter' })
			else this.dismiss()
		}
	}

	/** A press in the workspace area: a tab, the "+", a border to drag, or a pane to focus. */
	private workspacePress(event: MouseEvent): void {
		const layout = this.layout()
		const entry = this.roster.selected
		if (!entry) return
		if (event.y === layout.tabBar.y) {
			const bar = layoutTabBar(this.roster.spaceOf(entry), layout.tabBar)
			const target = tabBarTarget(bar, event.x, event.y)
			if (target?.kind === 'new') this.newTab()
			else if (target?.kind === 'tab') this.open(target.tab.focus)
			return
		}
		const placement = this.placement()
		if (!placement) return
		const divider = dividerAt(placement.dividers, event.x, event.y)
		if (divider) {
			const pointer = divider.split.dir === 'side' ? event.x : event.y
			this.drag = { split: divider.split, offset: pointer - divider.at }
			return
		}
		const pane = paneAt(placement.panes, event.x, event.y)
		if (pane) this.open(pane.entry)
	}

	/** Moves the border being dragged to follow the pointer. */
	private dragBorder(event: MouseEvent): void {
		const drag = this.drag
		const placement = this.placement()
		if (!drag || !placement) return
		const divider = placement.dividers.find((d) => d.split === drag.split)
		if (!divider) {
			this.drag = undefined
			return
		}
		const at = (drag.split.dir === 'side' ? event.x : event.y) - drag.offset
		const ratio = ratioFor(divider, at)
		if (ratio === drag.split.ratio) return
		drag.split.ratio = ratio
		this.fit()
		this.requestRender()
	}

	private revealSelected(): void {
		const layout = this.layout()
		const height = layout.sidebar?.height
		if (height === undefined) return
		this.sidebarScroll = clampScroll(
			this.sidebarScroll,
			this.sidebarModel(layout.rail),
			height,
			true,
		)
	}

	// --- drawing ---------------------------------------------------------------

	/** The question or name field a modal shows, if one is open. */
	private modalSpec(): ModalSpec | undefined {
		const entry = this.roster.selected
		const prompt = this.prompt
		if (prompt) {
			const titles: Record<Prompt['kind'], string> = {
				folder: 'open folder',
				'new-space': 'new space',
				'rename-session': 'rename pane',
				'rename-space': 'rename space',
				'rename-tab': prompt.fresh ? 'new tab' : 'rename tab',
			}
			const create = prompt.kind === 'folder' || prompt.kind === 'new-space' || prompt.fresh
			return {
				title: titles[prompt.kind],
				input: { value: prompt.value },
				...(prompt.error ? { error: prompt.error } : {}),
				buttons: [
					{ label: create ? '↲ open' : '↲ save', action: 'confirm', primary: true },
					{ label: '^c clear', action: 'clear' },
					{ label: 'esc cancel', action: 'cancel' },
				],
			}
		}
		if (this.confirm === 'quit')
			return {
				title: 'Quit all sessions?',
				danger: true,
				lines: ['Every session is hung up. The layout is kept for next time.'],
				buttons: [
					{ label: '↲ quit', action: 'confirm', primary: true },
					{ label: 'esc cancel', action: 'cancel' },
				],
			}
		if (this.confirm && entry) {
			const space = this.roster.spaceOf(entry)
			const count = this.roster.entriesOf(space).length
			return {
				title: 'Close space?',
				danger: true,
				lines: [`${space.name} — ${count} ${count === 1 ? 'pane' : 'panes'}`],
				buttons: [
					{ label: '↲ confirm', action: 'confirm', primary: true },
					{ label: 'esc cancel', action: 'cancel' },
				],
			}
		}
		return undefined
	}

	private pickerSpec(picker: Picker): ListSpec {
		return {
			title: `Start a session in ${picker.space.name} on`,
			rows: picker.choices.map((c) => ({ text: c.text })),
			index: picker.index,
			scroll: 0,
			footer: 'j/k pick   ↲ start   esc cancel',
			width: 52,
		}
	}

	private helpSpec(help: Help): ListSpec {
		return {
			title: 'keybinds',
			rows: helpRows(this.options.prefix.name).map((r) =>
				r.heading !== undefined
					? { text: r.heading, heading: true }
					: { text: r.label ?? '', ...(r.keys !== undefined ? { keys: r.keys } : {}) },
			),
			index: -1,
			scroll: help.scroll,
			footer: '↑/↓ scroll   esc close',
			width: 58,
		}
	}

	private gotoSpec(goto: Goto): ListSpec {
		const rows = this.gotoVisible()
		return {
			title: 'go to',
			input: { value: goto.query },
			rows:
				rows.length === 0
					? [{ text: 'nothing matches', muted: true }]
					: rows.map((r) => {
							const dot = dotStyle(r.dot, this.palette)
							return { text: r.text, indent: r.depth * 2, dot, heading: false }
						}),
			index: rows.length === 0 ? -1 : Math.min(goto.index, rows.length - 1),
			scroll: goto.scroll,
			footer: 'type to filter   ↑/↓ move   ↲ go   esc close',
			width: 64,
		}
	}

	private accountsSpec(list: Accounts): ListSpec {
		let accounts: readonly HostAccount[] = []
		try {
			accounts = (this.options.accounts?.() ?? []).filter((a) => a.label !== 'default')
		} catch {
			accounts = []
		}
		const rows: ListSpec['rows'] = [
			{ text: 'Usual sign-in', muted: true },
			...accounts.map((a) => ({ text: `${a.label}  ${a.provider}` })),
			{ text: accounts.length === 0 ? 'No other accounts yet.' : '', muted: true },
			{ text: 'Add one with /auth in any session.', muted: true },
		]
		return {
			title: 'accounts',
			rows,
			index: -1,
			scroll: list.scroll,
			footer: '↑/↓ scroll   esc close',
			width: 52,
		}
	}

	/** The menu popup: above the "new / menu" row at the sidebar's left, or at the top of the main area when there is no sidebar. */
	private menuSurface(): Surface {
		const layout = this.layout()
		const items: readonly string[] = MENU_ITEMS
		const height = items.length + 2
		if (!layout.sidebar || layout.rail)
			return layoutPopup(this.screen(), { x: layout.main.x + 1, y: layout.main.y + 1 }, items)
		const geo = geometry(layout.sidebar.height, 0, this.split, false)
		return layoutPopup(
			this.screen(),
			{ x: 1, y: Math.max(0, (geo.footerY ?? 0) - height) },
			items,
			Math.min(layout.sidebar.width - 2, 18),
		)
	}

	/** What the bottom bar says in a mode: a chip, then keys and what they do. */
	private modeBar(mode: InputMode): {
		chip: string
		chipBg: number
		hints: [string, string][]
	} {
		const prefix = this.options.prefix.name
		if (mode === 'resize')
			return {
				chip: 'RESIZE',
				chipBg: this.palette.mauve,
				hints: [
					['esc', 'done'],
					['h/l', 'width'],
					['j/k', 'height'],
				],
			}
		if (mode === 'navigate')
			return {
				chip: 'NAVIGATE',
				chipBg: this.palette.accent,
				hints: [
					['esc', 'back'],
					['↑/↓', 'space'],
					['tab', 'pane'],
					['?', 'keybinds'],
				],
			}
		return {
			chip: 'PREFIX',
			chipBg: this.palette.accent,
			hints: [
				['esc', 'cancel'],
				[prefix, 'send prefix'],
				['w', 'space nav'],
				['?', 'keybinds'],
			],
		}
	}

	private drawModeBar(frame: Frame, area: Rect, mode: InputMode): void {
		const { palette } = this
		const bar = this.modeBar(mode)
		frame.fillRect(area, { bg: palette.panelBg })
		let x = 0
		const put = (text: string, style: { fg: number; bg: number; attrs?: number }): void => {
			x += frame.writeText({ ...area, x: area.x + x, width: area.width - x }, 0, text, style)
		}
		put(` ${bar.chip} `, {
			fg: palette.panelBg,
			bg: bar.chipBg,
			attrs: ATTR_BOLD,
		})
		put(' ', { fg: palette.dim, bg: palette.panelBg })
		for (const [key, what] of bar.hints) {
			put(key, { fg: palette.accent, bg: palette.panelBg, attrs: ATTR_BOLD })
			put(` ${what}  `, { fg: palette.dim, bg: palette.panelBg })
		}
	}

	private requestRender(): void {
		if (this.closed || this.pending) return
		const cancel = this.schedule(() => {
			this.pending = undefined
			void this.render()
		}, FRAME_MS)
		this.pending = cancel
	}

	/** Paints the current state now, after the emulator has taken all output received so far. */
	render(): Promise<void> {
		this.rendering = this.rendering
			.then(() => this.paint())
			.then(
				() => {
					this.paintFailures = 0
				},
				() => this.paintFailed(),
			)
		return this.rendering
	}

	/** A drawing error never ends the chain; repeated ones close the host so the terminal is restored. */
	private paintFailed(): void {
		this.paintFailures++
		if (this.paintFailures >= MAX_PAINT_FAILURES) {
			this.quit()
			return
		}
		this.notice = 'Could not redraw the screen.'
		this.requestRender()
	}

	private async paint(): Promise<void> {
		if (this.closed) return
		const entry = this.roster.selected
		const placement = this.placement()
		const panes = placement?.panes ?? []
		// Every pane on screen settles before it is copied, so none shows a half-written screen.
		await Promise.all(panes.map((p) => p.entry.child?.screen.settled()))
		if (this.closed) return
		const { output } = this.options
		const frame = new Frame(output.columns, output.rows)
		const layout = this.layout()
		if (layout.sidebar) {
			const model = this.sidebarModel(layout.rail)
			this.sidebarScroll = clampScroll(this.sidebarScroll, model, layout.sidebar.height)
			drawSidebar(frame, layout.sidebar, {
				...model,
				scroll: this.sidebarScroll,
			})
		}
		if (layout.rule) drawRule(frame, layout.rule, this.palette)
		if (entry) drawTabBar(frame, layout.tabBar, this.roster.spaceOf(entry), this.palette)
		// The focused pane is drawn last, so the cursor is the one it sets.
		const ordered = [...panes].sort((a, b) => Number(a.entry === entry) - Number(b.entry === entry))
		for (const pane of ordered)
			this.drawPane(frame, pane, pane.entry === entry, placement?.bordered ?? false)
		if (this.reorder) this.drawDrop(frame, layout)
		const area = {
			...layout.main,
			y: layout.main.y + layout.main.height - 1,
			height: 1,
		}
		const mode = this.router.current
		const asking = this.captured()
		if (mode !== 'terminal' && !asking) this.drawModeBar(frame, area, mode)
		else if (this.notice && !asking) {
			frame.fillRect(area, { bg: this.palette.panelBg })
			frame.writeText(area, 0, ` ${this.notice}`, {
				fg: this.palette.yellow,
				bg: this.palette.panelBg,
			})
		}
		this.drawOverlay(frame)
		if (mode !== 'terminal' || asking)
			frame.setCursor({ x: frame.cursor.x, y: frame.cursor.y, visible: false })
		let out = ''
		const wantPaste = entry?.child?.screen.bracketedPaste() ?? false
		if (wantPaste !== this.pasteOn) {
			this.pasteOn = wantPaste
			out += wantPaste ? '\x1b[?2004h' : '\x1b[?2004l'
		}
		out += this.writer.render(frame)
		if (out !== '') output.write(out)
		// Branches are read only once the first frame is out, and never again inside a paint.
		if (!this.gitStarted) {
			this.gitStarted = true
			this.armGit(true)
		}
	}

	/** Reads every space's branch now and then again on a timer. */
	private armGit(now = false): void {
		if (this.closed) return
		if (now) this.git.refreshAll(this.roster.spaces.map((s) => s.cwd))
		this.cancelGit = this.schedule(() => {
			this.git.refreshAll(this.roster.spaces.map((s) => s.cwd))
			this.armGit()
		}, GIT_MS)
	}

	/** Draws the open overlay on top; a modal first dims everything under it. */
	private drawOverlay(frame: Frame): void {
		const { palette } = this
		const screen = this.screen()
		if (this.context) {
			const items = CONTEXT_ITEMS[this.context.target.kind]
			drawPopup(
				frame,
				layoutPopup(screen, this.context.at, items),
				items,
				this.context.index,
				palette,
			)
			return
		}
		if (this.menu) {
			drawPopup(frame, this.menuSurface(), MENU_ITEMS, this.menu.index, palette)
			return
		}
		const modal = this.modalSpec()
		const list = this.listSpec()
		if (!modal && !list) return
		dimFrame(frame)
		if (modal) drawModal(frame, layoutModal(screen, modal), modal, palette)
		else if (list) drawList(frame, layoutList(screen, list), list, palette)
	}

	/** The line a dragged space would land at: under the row above the place it would take. */
	private drawDrop(frame: Frame, layout: Layout): void {
		const drag = this.reorder
		const sidebar = layout.sidebar
		if (!drag || !sidebar) return
		const from = this.roster.spaces.indexOf(drag.space)
		if (drag.to === from) return
		const geo = geometry(sidebar.height, 0, this.split, layout.rail)
		const shown = drag.to - this.sidebarScroll.spaces
		if (shown < 0 || shown >= geo.spaceCap) return
		const top = geo.spaceTop + shown * geo.spaceStep
		const y = (drag.to < from ? top : top + geo.spaceStep) - 1
		for (let x = 0; x < sidebar.width; x++) {
			const cell = frame.cellAt(x, y)
			if (!cell) continue
			frame.set(x, y, {
				...cell,
				fg: cell.ch === ' ' ? this.palette.accent : cell.fg,
				attrs: cell.attrs | ATTR_UNDERLINE,
			})
		}
	}

	/** One pane: its border (the focused one in the accent colour), then its session or what stands in for it. */
	private drawPane(
		frame: Frame,
		pane: { entry: Entry; outer: Rect; inner: Rect },
		focused: boolean,
		bordered: boolean,
	): void {
		const { entry, outer, inner } = pane
		if (bordered) drawBox(frame, outer, focused ? this.palette.accent : this.palette.dim)
		const child = entry.child
		if (child) {
			frame.blit(child.screen.cells(entry.scrollBack), inner)
			const last = { ...inner, y: inner.y + inner.height - 1, height: 1 }
			if (child.status === 'exited') {
				frame.fillRect(last, { attrs: ATTR_INVERSE })
				frame.writeText(last, 0, ` ${endedMessage(child.ending, this.options.prefix.name)}`, {
					attrs: ATTR_INVERSE,
				})
				if (focused) frame.setCursor({ x: 0, y: 0, visible: false })
			} else if (entry.scrollBack > 0) {
				frame.fillRect(last, { attrs: ATTR_INVERSE })
				frame.writeText(last, 0, ' Scrolled back. Scroll down or type to return.', {
					attrs: ATTR_INVERSE,
				})
			}
			return
		}
		const space = this.roster.spaceOf(entry)
		const say = (row: number, text: string): void => void frame.writeText(inner, row, text)
		if (entry.folderMissing) {
			say(1, ` The folder for "${entry.label}" was not found.`)
			say(2, ` ${space.cwd}`)
			say(3, ' Put it back or remove this space, then press enter to try again.')
		} else if (entry.openElsewhere) {
			say(1, ` "${entry.label}" is open in another terminal.`)
			say(2, ' Close it there, then press enter to open it here.')
		} else if (entry.checking) say(1, ` Opening "${entry.label}"...`)
		else {
			say(1, ` "${entry.label}" in ${space.name} has not started yet.`)
			say(2, ' Press enter or click it to open it.')
		}
	}

	// --- remembering the layout ------------------------------------------------

	/** What is written between runs: spaces with their tabs and pane trees, and where focus is. */
	snapshot(): SavedLayout {
		const selected = this.roster.selected
		const saveNode = (node: Node): SavedNode => {
			if (node.kind === 'split')
				return {
					split: node.dir,
					ratio: node.ratio,
					a: saveNode(node.a),
					b: saveNode(node.b),
				}
			const entry = node.entry
			const conversationId = entry.conversationId ?? entry.resume
			return {
				session: {
					label: entry.label,
					...(conversationId ? { conversationId } : {}),
					...(entry.account ? { account: entry.account } : {}),
					...(entry.pickedAccount ? { pickedAccount: entry.pickedAccount } : {}),
				},
			}
		}
		const saveTab = (tab: Tab): SavedTab => {
			const focus = leaves(tab.root).indexOf(tab.focus)
			return {
				...(tab.name ? { name: tab.name } : {}),
				tree: saveNode(tab.root),
				...(focus > 0 ? { focus } : {}),
				...(tab.zoomed ? { zoomed: true } : {}),
			}
		}
		const spaces = this.roster.spaces.map((space) => {
			const active = space.activeTab ? space.tabs.indexOf(space.activeTab) : 0
			return {
				name: space.name,
				cwd: space.cwd,
				...(space.lastAccount ? { lastAccount: space.lastAccount } : {}),
				tabs: space.tabs.map(saveTab),
				...(active > 0 ? { activeTab: active } : {}),
			}
		})
		const space = selected ? this.roster.spaces.indexOf(this.roster.spaceOf(selected)) : -1
		const sidebar = {
			...(this.sidebar.collapsed ? { collapsed: true as const } : {}),
			...(this.sidebar.width !== SIDEBAR_DEFAULT ? { width: this.sidebar.width } : {}),
			...(this.split !== 0.5 ? { split: this.split } : {}),
			...(this.order !== 'grouped' ? { order: this.order } : {}),
		}
		return {
			version: 2,
			spaces,
			...(space >= 0 ? { focus: { space } } : {}),
			...(Object.keys(sidebar).length > 0 ? { sidebar } : {}),
		}
	}

	/** Writes the layout soon; a burst of changes becomes one write. */
	private persist(): void {
		if (!this.options.store || this.closed || this.cancelSave) return
		this.cancelSave = this.schedule(() => {
			this.cancelSave = undefined
			this.writeLayout()
		}, SAVE_MS)
	}

	private writeLayout(): void {
		const store = this.options.store
		if (!store) return
		try {
			store.save(this.forgetAll ? { version: 2, spaces: [] } : this.snapshot())
		} catch {
			// Remembering the layout is a convenience; a failure never stops the host.
		}
	}

	/** Ends every session, then leaves the terminal as it was found. */
	quit(): void {
		if (this.quitting || this.closed) return
		this.quitting = true
		const live = this.everyChild().filter((s) => s.status !== 'exited')
		if (live.length === 0) {
			this.close()
			return
		}
		for (const session of live) session.stop('SIGHUP')
		this.cancelKill = this.schedule(() => {
			for (const session of live) session.stop('SIGKILL')
			this.close()
		}, QUIT_GRACE_MS)
		// The sessions report their ends through childChanged, which closes once all are gone.
	}

	private close(): void {
		if (this.closed) return
		this.cancelSave?.()
		this.cancelSave = undefined
		this.writeLayout()
		this.closed = true
		this.cancelKill?.()
		this.cancelPoll?.()
		this.cancelReconcile?.()
		this.cancelGit?.()
		this.stopWatching?.()
		this.pending?.()
		const { input, output } = this.options
		input.off('data', this.onData)
		output.off('resize', this.onResize)
		process.off('exit', this.onProcessExit)
		input.setRawMode?.(false)
		input.pause?.()
		output.write(LEAVE_SCREEN)
		for (const child of this.everyChild()) child.dispose()
		this.finish(0)
	}
}
