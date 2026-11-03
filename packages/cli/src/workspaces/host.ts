import { randomUUID } from 'node:crypto'
import { existsSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import stringWidth from 'string-width'
import {
	type ClipboardCopier,
	type CopyHost,
	bypassKey,
	createClipboardCopier,
	describeCopy,
} from '../integrations/clipboard/copy.js'
import { MAX_CLIPBOARD_TEXT_BYTES } from '../integrations/clipboard/text.js'
import { ATTR_BOLD, ATTR_INVERSE, ATTR_UNDERLINE } from '../terminal/host/cell.js'
import { type CellStyle, Frame, type Rect } from '../terminal/host/frame.js'
import { DiffWriter } from '../terminal/host/writer.js'
import type { HostPtyModule } from '../terminal/pty.js'
import type { HeadlessScreen } from '../terminal/screen.js'
import { activeThemeName } from '../tui/theme.js'
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
	TAB_BAR_HEIGHT,
	clampSidebarWidth,
	computeLayout,
} from './layout.js'
import { LEAVE_SCREEN, LEAVE_TO_NATIVE, type MouseMode, enterScreen, mouseOn } from './mouse.js'
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
import { type ColorLevel, type Palette, colorLevel, paletteFor } from './palette.js'
import { type PeerSource, recordForPid, recordForSlot } from './peers.js'
import type { Prefix } from './prefix.js'
import { type Entry, Roster, type Tab, type Workspace } from './roster.js'
import {
	ClickCounter,
	type Point,
	type Range,
	colsOnLine,
	extractText,
	lineAt,
	orderRange,
	snapRange,
	wordAt,
} from './selection.js'
import {
	ChildSession,
	type LocalPaneSession,
	type PaneSession,
	type SessionSpec,
} from './session.js'
import {
	type AgentOrder,
	type SidebarScroll,
	agentList,
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
import type { SignalName } from './signal.js'
import type { SavedLayout, SavedNode, SavedTab, WorkspacesStore } from './store.js'
import { drawTabBar, ellipsize, layoutTabBar, tabBarTarget } from './tabbar.js'
import {
	type Direction,
	type Divider,
	MIN_PANE_HEIGHT,
	MIN_PANE_WIDTH,
	type Node,
	type Placement,
	SPLIT_GAP,
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

/** The signals that end the process without going through its exit handlers. */
export type EndingSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP'
const ENDING_SIGNALS: readonly EndingSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

/** What the host needs of the process to hand the terminal back when a signal ends it. Injected so tests own them. */
export interface SignalHooks {
	on(signal: EndingSignal, listener: () => void): void
	off(signal: EndingSignal, listener: () => void): void
	count(signal: EndingSignal): number
	/** Sends the signal to this process again, now that nothing of the host listens. */
	raise(signal: EndingSignal): void
	/** Writes to the terminal at once, bypassing any buffer a dying process would lose. */
	writeNow(text: string): void
}

export const realSignalHooks: SignalHooks = {
	on: (signal, listener) => void process.on(signal, listener),
	off: (signal, listener) => void process.off(signal, listener),
	count: (signal) => process.listenerCount(signal),
	raise: (signal) => void process.kill(process.pid, signal),
	writeNow: (text) => void writeSync(1, text),
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

/**
 * The conversation this process is already running, when the host lives inside
 * it. It becomes a pane like the others, never started or hung up by the host.
 */
export interface LocalPane {
	readonly session: LocalPaneSession
	/** The id of the conversation it is in, once it has one; a pane that carries it is this session. */
	readonly conversationId: () => string | undefined
}

export interface WorkspacesHostOptions {
	readonly input: HostInput
	readonly output: HostOutput
	readonly binding: HostPtyModule
	/** The program for a session. */
	readonly spec: (request: SessionRequest) => SessionSpec
	/** The workspace the host opens with, and starts a session in. */
	readonly folder: { readonly cwd: string; readonly name: string }
	/** Workspaces and sessions shown but not started until opened. */
	readonly listed?: readonly { cwd: string; name: string; sessions: number }[]
	readonly prefix: Prefix
	/** The accounts a new session can start on; none means every session starts on the usual sign-in. */
	readonly accounts?: () => readonly HostAccount[]
	/** Where the layout is remembered between runs. */
	readonly store?: WorkspacesStore
	/** The layout of the previous run, shown at start with its sessions not yet started. */
	readonly restored?: SavedLayout
	/** True when the command carries its own options, which then start a fresh session instead of restoring focus. */
	readonly freshFirst?: boolean
	/** Whether a conversation is already open in another terminal; asked before a restored session starts. */
	readonly inUseElsewhere?: (query: ConversationQuery) => Promise<boolean>
	/** How much colour to draw in; by default what the terminal and the environment (`NO_COLOR`, `COLORTERM`) say. */
	readonly colors?: ColorLevel
	readonly schedule?: Schedule
	/** Reads a folder's branch for the sidebar; asked after the first frame, never while one is drawn. */
	readonly git?: GitLookup
	/** The clock, for the double-click that resets the sidebar's width. */
	readonly now?: () => number
	/** How a session's whole process tree is ended; the default signals its process group. */
	readonly kill?: ConstructorParameters<typeof ChildSession>[4]
	/** Where the sessions' states come from; without it every started session shows as starting. */
	readonly peers?: PeerSource
	/** The session the host runs inside of; the host then starts hidden, until `openWorkspaces`. */
	readonly local?: LocalPane
	/** How much of the pointer is asked of the terminal; `full` when absent. */
	readonly mouse?: MouseMode
	/** Whether a selection is copied when the button is released; true when absent. */
	readonly copyOnSelect?: boolean
	/** The environment that decides how a copy is wrapped for the terminal and which key the hint names. */
	readonly env?: NodeJS.ProcessEnv
	/** Test seam for the clipboard tools: the runner, PATH lookup and platform. */
	readonly clipboard?: Omit<CopyHost, 'env'>
	/** The process's signals, for handing the terminal back when one ends it. */
	readonly signals?: SignalHooks
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
/** How often each workspace's branch is read again. */
const GIT_MS = 5000
/** A workspace shown again within this long of its last look is not looked at again. */
const GIT_STALE_MS = 1500
/** Two presses on the sidebar's edge within this long reset its width. */
const DOUBLE_CLICK_MS = 400
/** A forwarded clipboard request from one pane at most this often. */
const FORWARD_MS = 250
/** How long the note about a copy stays, and the selection with it. */
const COPY_NOTE_MS = 2000
/** How long a note that something went wrong stays. */
const COPY_ERROR_MS = 4000
/** Rows one wheel notch moves. */
const WHEEL_ROWS = 3

/** Drawing errors in a row before the host closes instead of retrying. */
const MAX_PAINT_FAILURES = 3

/** A selection in progress or finished: where it was made and between which cells of the emulator's lines. */
interface PaneSelection {
	readonly entry: Entry
	readonly screen: HeadlessScreen
	readonly cols: number
	readonly rows: number
	inner: Rect
	anchor: Point
	focus: Point
	/** 1 for a drag, 2 and 3 for a word and a line chosen by a double and a triple click. */
	readonly unit: 1 | 2 | 3
	/** The button is still down, so the pointer extends it. */
	pressing: boolean
	/** Something is highlighted: a drag, a double click or a triple click happened. */
	active: boolean
	/** Copied once already; a second ctrl+c clears instead. */
	copied: boolean
}

type Prompt = {
	kind: 'folder' | 'new-workspace' | 'rename-session' | 'rename-workspace' | 'rename-tab'
	value: string
	/** A tab that was just made: it asks for a name instead of changing one. */
	fresh?: boolean
	error?: string
}
type Confirm = 'quit' | 'close-workspace'
/** The popup behind the sidebar's "menu". */
const MENU_ITEMS = ['accounts', 'add account', 'sidebar', 'keybinds', 'quit'] as const
interface Menu {
	index: number
}
/** The account choice offered when a session is started. */
interface Picker {
	readonly workspace: Workspace
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
/** The go-to overlay: a typed filter over the tree of workspaces, tabs and panes. */
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
	| { readonly kind: 'workspace'; readonly workspace: Workspace }
	| { readonly kind: 'tab'; readonly tab: Tab }
	| { readonly kind: 'pane'; readonly entry: Entry }
type ContextItem = 'Rename' | 'New tab' | 'Split right' | 'Split down' | 'Zoom' | 'Close'
const CONTEXT_ITEMS: Record<ContextTarget['kind'], readonly ContextItem[]> = {
	workspace: ['Rename', 'New tab', 'Close'],
	tab: ['Rename', 'Close'],
	pane: ['Rename', 'Split right', 'Split down', 'Zoom', 'Close'],
}
interface Context {
	readonly target: ContextTarget
	readonly at: { readonly x: number; readonly y: number }
	index: number
}

function inRect(rect: Rect, x: number, y: number): boolean {
	return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
}

function defaultIsDirectory(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).isDirectory()
	} catch {
		return false
	}
}

/**
 * The workspaces shell: a sidebar of workspaces and sessions, and beside it the shown
 * workspace's tab, a tiling of panes, each a session.
 *
 * It draws and routes keys and nothing else. Each session is a whole `namzu`
 * running in its own pseudo-terminal, so a session that crashes greys its row and
 * the rest keep running. What a session is doing comes from the live record its
 * terminal publishes, never from reading its screen.
 */
export class WorkspacesHost {
	readonly roster = new Roster()
	private sidebar: SidebarSetting = DEFAULT_SIDEBAR
	private split = 0.5
	private order: AgentOrder = 'grouped'
	private menu: Menu | undefined
	private sidebarScroll: SidebarScroll = { workspaces: 0, agents: 0 }
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
	/** A workspace being dragged in the sidebar, and the place it would land. */
	private reorder: { workspace: Workspace; to: number } | undefined
	private cancelSave: (() => void) | undefined
	private forgetAll = false
	private notice: string | undefined
	/** The text being selected in a pane, if any. */
	private select: PaneSelection | undefined
	private readonly clicks: ClickCounter
	private tipShown = false
	private cancelNote: (() => void) | undefined
	private readonly watched = new WeakSet<HeadlessScreen>()
	private readonly lastForward = new WeakMap<HeadlessScreen, number>()
	private readonly pendingForward = new Map<HeadlessScreen, string>()
	private pasteOn = false
	private pending: (() => void) | undefined
	private rendering: Promise<void> = Promise.resolve()
	private closed = false
	/** True while the real terminal belongs to the local session and nothing of the host is drawn. */
	private hidden = false
	/** `split` is the workspaces screen; `full` draws the selected child alone on the whole terminal. */
	private view: 'split' | 'full' = 'split'
	private localEntry: Entry | undefined
	private quitting = false
	/** Answers the running conversation's wish to end while other sessions are mid-turn. */
	private exitGate: ((leave: boolean) => void) | undefined
	private paintFailures = 0
	private cancelKill: (() => void) | undefined
	private cancelPoll: (() => void) | undefined
	private cancelReconcile: (() => void) | undefined
	private stopWatching: (() => void) | undefined
	private reconciling = false
	private readonly leaving: PaneSession[] = []
	private paletteCache: { level: ColorLevel; theme: string; palette: Palette } | undefined
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
	private readonly onResize = (): void => {
		// Some terminals forget the pointer modes when they are resized.
		if (!this.hidden && !this.closed) this.options.output.write(mouseOn(this.mouseMode))
		this.relayout()
	}
	private readonly signalListeners = new Map<EndingSignal, () => void>()
	/** A signal is ending the process: give the terminal back now, before the default action kills us. */
	private signalled(signal: EndingSignal): void {
		const hooks = this.options.signals ?? realSignalHooks
		if (!this.hidden && !this.closed) {
			try {
				hooks.writeNow(LEAVE_SCREEN)
			} catch {
				// The terminal may already be gone.
			}
			// Nothing of the host is drawn after this, whoever ends up closing it.
			this.hidden = true
		}
		this.releaseSignals()
		if (hooks.count(signal) === 0) hooks.raise(signal)
		// Someone else handles the signal and may ignore it: the host still finishes closing.
		else this.quit()
	}
	private armSignals(): void {
		const hooks = this.options.signals ?? realSignalHooks
		for (const signal of ENDING_SIGNALS) {
			const listener = (): void => this.signalled(signal)
			this.signalListeners.set(signal, listener)
			hooks.on(signal, listener)
		}
	}
	private releaseSignals(): void {
		const hooks = this.options.signals ?? realSignalHooks
		for (const [signal, listener] of this.signalListeners) hooks.off(signal, listener)
		this.signalListeners.clear()
	}
	private get mouseMode(): MouseMode {
		return this.options.mouse ?? 'full'
	}
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
			if (!this.hidden) this.options.output.write(LEAVE_SCREEN)
		} catch {
			// The terminal may already be gone.
		}
		for (const session of this.everyChild()) {
			if (session.local) continue
			try {
				session.stop('SIGHUP')
			} catch {
				// Already ended.
			}
		}
	}

	/** The chrome's colours, from the theme showing now: a theme switched in the TUI restyles the screen at its next frame. */
	private get palette(): Palette {
		const level = this.options.colors ?? colorLevel(process.env)
		const theme = activeThemeName()
		const cached = this.paletteCache
		if (cached && cached.level === level && cached.theme === theme) return cached.palette
		const palette = paletteFor(level)
		this.paletteCache = { level, theme, palette }
		return palette
	}

	constructor(private readonly options: WorkspacesHostOptions) {
		this.router = new InputRouter(options.prefix)
		this.schedule = options.schedule ?? realSchedule
		this.clicks = new ClickCounter(options.now ?? Date.now, DOUBLE_CLICK_MS)
		this.git = new GitCache(
			options.git ?? gitLookup,
			() => this.requestRender(),
			options.now ?? Date.now,
		)
		this.hidden = options.local !== undefined
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
		const { input, output, local } = this.options
		// Inside a conversation the terminal is already raw and belongs to it; nothing is drawn until `openWorkspaces`.
		if (!local) output.write(enterScreen(this.mouseMode))
		input.setEncoding?.('utf8')
		input.setRawMode?.(true)
		input.resume?.()
		input.on('data', this.onData)
		output.on('resize', this.onResize)
		process.once('exit', this.onProcessExit)
		this.armSignals()
		if (local) this.seedLocal(local)
		else this.open(this.options.restored ? this.restore(this.options.restored) : this.fresh())
		this.armPoll()
		this.armReconcile()
		this.stopWatching = this.options.peers?.watch?.(() => this.readStatus())
		this.requestRender()
	}

	/**
	 * Brings back the saved workspaces and makes the running conversation one of the
	 * panes: the one that carries its conversation id, or else a new tab in the
	 * workspace of its folder. Nothing else is started here.
	 */
	private seedLocal(local: LocalPane): void {
		const layout = this.options.restored
		if (layout) this.restoreWorkspaces(layout)
		const id = local.conversationId()
		const carried = id
			? this.roster.entries.find((e) => (e.conversationId ?? e.resume) === id)
			: undefined
		let entry = carried
		if (!entry) {
			const { cwd, name } = this.options.folder
			const workspace =
				this.roster.workspaces.find((s) => s.cwd === cwd) ?? this.roster.addWorkspace(cwd, name)
			entry = this.newTabIn(workspace)
		}
		entry.child = local.session
		this.watchClipboard(local.session.screen)
		entry.resume = undefined
		entry.first = false
		entry.verifyFolder = false
		entry.folderMissing = false
		entry.openElsewhere = false
		entry.checking = false
		if (id) entry.conversationId = id
		const adopted = entry
		local.session.observe(() => this.childChanged(adopted))
		this.localEntry = entry
		this.roster.select(entry)
		this.roster.update(entry)
		this.persist()
	}

	/** True while the workspaces screen is on the terminal. */
	get visible(): boolean {
		return !this.hidden && !this.closed
	}

	/** Puts the workspaces screen up, with the running conversation selected and the keyboard on the sidebar. */
	openWorkspaces(): void {
		const entry = this.localEntry
		if (this.closed || !entry) return
		if (this.hidden) {
			this.hidden = false
			this.options.output.write(enterScreen(this.mouseMode))
			this.pasteOn = false
			this.writer.invalidate()
		}
		this.view = 'split'
		this.dismiss()
		this.roster.select(entry)
		this.fit()
		const size = this.paneSize(entry)
		this.options.local?.session.attach(size.cols, size.rows)
		if (this.options.local) this.watchClipboard(this.options.local.session.screen)
		this.startShown()
		this.router.enterNavigate()
		this.persist()
		this.requestRender()
	}

	/** Hands the terminal to the running conversation: leaves the alternate screen and lets it repaint. */
	private openNative(): void {
		const local = this.options.local
		const entry = this.localEntry
		if (this.hidden || !local || !entry) return
		this.roster.select(entry)
		this.hidden = true
		this.view = 'split'
		this.dismiss()
		this.router.focus()
		this.pending?.()
		this.pending = undefined
		this.options.output.write(LEAVE_TO_NATIVE)
		this.pasteOn = false
		local.session.detach()
	}

	/**
	 * The conversation is about to unmount: gives the main screen back and has the conversation print
	 * its whole history there, so Ink's last frame lands on a screen that is already right. True when
	 * the workspaces screen was up and has been left.
	 */
	releaseTerminal(): boolean {
		if (this.closed || this.hidden || !this.localEntry || !this.options.local) return false
		this.openNative()
		return true
	}

	/**
	 * Runs `run` with the terminal handed back to the real shell (an editor, a pager): the pointer is
	 * switched off and the main screen returns first, and the workspaces screen is entered again afterwards
	 * even if `run` throws. Nothing happens around `run` when the workspaces screen is not on the terminal.
	 */
	async withTerminalHandoff<T>(run: () => Promise<T> | T): Promise<T> {
		if (this.closed || this.hidden) return await run()
		this.options.output.write(LEAVE_TO_NATIVE)
		this.pasteOn = false
		try {
			return await run()
		} finally {
			if (!this.closed && !this.hidden) {
				this.options.output.write(enterScreen(this.mouseMode))
				this.writer.invalidate()
				this.requestRender()
			}
		}
	}

	/** Moves the keyboard from a pane to the sidebar of the workspaces screen. */
	focusSidebar(): void {
		if (this.closed || this.hidden || this.view === 'full') return
		this.router.enterNavigate()
		this.requestRender()
	}

	/** What a hosted session asked of the host through its terminal. */
	private childSignal(entry: Entry, signal: SignalName): void {
		if (this.closed || this.hidden || signal !== 'zoom-out') return
		if (this.view === 'full') {
			if (this.roster.selected !== entry) return
			this.view = 'split'
			this.fit()
			this.router.enterNavigate()
			this.writer.invalidate()
			this.requestRender()
			return
		}
		if (this.roster.selected === entry && this.router.current === 'terminal') {
			this.router.enterNavigate()
			this.requestRender()
		}
	}

	// --- sessions --------------------------------------------------------------

	/** The first run: the current folder as a workspace with the session the command started. */
	private fresh(): Entry {
		const workspace = this.roster.addWorkspace(this.options.folder.cwd, this.options.folder.name)
		const entry = this.newTabIn(workspace)
		entry.first = true
		for (const listed of this.options.listed ?? []) {
			const other = this.roster.addWorkspace(listed.cwd, listed.name)
			for (let i = 0; i < listed.sessions; i++) this.newTabIn(other)
		}
		return entry
	}

	/**
	 * Brings back the previous run's workspaces, tabs and panes, none of them started.
	 * The one shown is where focus was, unless the command carries its own options
	 * or its folder is new, which start a fresh session of their own.
	 */
	private restore(layout: SavedLayout): Entry {
		this.restoreWorkspaces(layout)
		const folder = this.roster.workspaces.find((s) => s.cwd === this.options.folder.cwd)
		if (this.options.freshFirst || !folder) {
			const workspace =
				folder ?? this.roster.addWorkspace(this.options.folder.cwd, this.options.folder.name)
			const entry = this.newTabIn(workspace)
			entry.first = true
			return entry
		}
		const focused =
			layout.focus !== undefined
				? this.roster.workspaces[layout.focus.workspace]?.activeTab?.focus
				: undefined
		return focused ?? folder.activeTab?.focus ?? this.newTabIn(folder)
	}

	private restoreWorkspaces(layout: SavedLayout): void {
		const isDirectory = this.options.isDirectory ?? defaultIsDirectory
		for (const saved of layout.workspaces) {
			const workspace = this.roster.addWorkspace(saved.cwd, saved.name)
			const found = isDirectory(saved.cwd)
			if (saved.lastAccount) workspace.lastAccount = saved.lastAccount
			for (const savedTab of saved.tabs) this.restoreTab(workspace, savedTab, found)
			const active = saved.activeTab !== undefined ? workspace.tabs[saved.activeTab] : undefined
			workspace.activeTab = active ?? workspace.tabs[0]
		}
	}

	private restoreTab(workspace: Workspace, saved: SavedTab, found: boolean): void {
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
			const entry = this.addEntry(workspace, item.label)
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
			workspace,
			root,
			panes[saved.focus ?? 0] ?? (panes[0] as Entry),
			saved.name,
			saved.zoomed === true,
		)
	}

	private addEntry(workspace: Workspace, label?: string): Entry {
		const entry = this.roster.addSession(workspace, this.options.newSlot?.() ?? randomUUID(), label)
		this.persist()
		return entry
	}

	/** A session in a tab of its own, after the workspace's other tabs. */
	private newTabIn(workspace: Workspace): Entry {
		const entry = this.addEntry(workspace)
		this.roster.addTab(workspace, entry)
		return entry
	}

	private layout(): Layout {
		const { columns, rows } = this.options.output
		if (this.view === 'full') {
			const whole: Rect = { x: 0, y: 0, width: columns, height: rows }
			return {
				sidebar: undefined,
				rail: false,
				rule: undefined,
				main: whole,
				tabBar: undefined,
				panes: whole,
			}
		}
		return computeLayout(columns, rows, this.sidebar)
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
		const selected = this.roster.selected
		if (this.view === 'full' && selected) {
			const whole = this.layout().panes
			return {
				panes: [{ entry: selected, outer: whole, inner: whole }],
				dividers: [],
				bordered: false,
			}
		}
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
			const found = (this.options.isDirectory ?? defaultIsDirectory)(
				this.roster.workspaceOf(entry).cwd,
			)
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
			const workspace = this.roster.workspaceOf(entry)
			void guard({ cwd: workspace.cwd, conversationId: entry.resume })
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
		const workspace = this.roster.workspaceOf(entry)
		const spec = this.options.spec({
			cwd: workspace.cwd,
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
			(signal) => this.childSignal(entry, signal),
		)
		entry.child = child
		this.watchClipboard(child.screen)
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
		// The running conversation is not drawn full screen by the host: it gets the terminal itself.
		if (this.view === 'full' && entry.child?.local) this.view = 'split'
		this.roster.select(entry)
		if (this.gitStarted) this.git.refresh(this.roster.workspaceOf(entry).cwd, GIT_STALE_MS)
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
		// A session shown full screen that ends leaves nothing to type into: back to the split view.
		if (
			this.view === 'full' &&
			!this.hidden &&
			this.roster.selected === entry &&
			entry.child?.status === 'exited'
		) {
			this.view = 'split'
			this.fit()
			this.router.enterNavigate()
			this.writer.invalidate()
		}
		if (this.quitting && this.everyChild().every((c) => c.status === 'exited')) this.close()
		else this.requestRender()
	}

	private everyChild(): PaneSession[] {
		const own = this.roster.entries.flatMap((e) => (e.child ? [e.child] : []))
		return [...own, ...this.leaving]
	}

	private relayout(): void {
		if (this.closed) return
		this.fit()
		if (this.hidden) return
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
			const record = entry.child.local
				? recordForPid(records, entry.child.pid)
				: recordForSlot(records, entry.slot, entry.child.pid)
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

	/** A session that moved to another account makes that account the one its workspace offers first. */
	private rememberAccount(entry: Entry, label: string | undefined): void {
		const workspace = this.roster.workspaceOf(entry)
		const matches = (this.options.accounts?.() ?? []).filter((a) => a.label === label)
		const found = label !== undefined && matches.length === 1 ? matches[0] : undefined
		// What a not-yet-conversing session would start on follows what it now runs on.
		entry.pickedAccount = found?.id
		if (label === undefined) delete workspace.lastAccount
		else if (found) workspace.lastAccount = found.id
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
				const record = entry.child.local
					? recordForPid(records, entry.child.pid)
					: recordForSlot(records, entry.slot, entry.child.pid)
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
		if (this.closed || this.hidden) return
		if (this.selectionKey(chunk)) return
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
		if (this.select?.entry === entry) this.clearSelect()
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
			case 'new-workspace':
				this.prompt = { kind: 'new-workspace', value: this.roster.workspaceOf(entry).cwd }
				return
			case 'open-folder':
				this.askFolder()
				return
			case 'rename-workspace':
				this.askName('rename-workspace', this.roster.workspaceOf(entry).name)
				return
			case 'close-workspace':
				this.confirm = 'close-workspace'
				return
			// The router starts these two modes itself; there is nothing more to do.
			case 'workspace-mode':
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

	/**
	 * The running conversation is about to end (`/exit`, ctrl+c twice). With no other session
	 * mid-turn it may go at once; otherwise the workspaces screen comes up with the quit question
	 * and the answer decides.
	 */
	askLocalExit(): Promise<boolean> {
		const busy = this.roster.entries.some((e) => {
			if (!e.child || e.child.local || e.child.status === 'exited') return false
			const activity = e.activity()
			return activity === 'working' || activity === 'needs-approval'
		})
		if (this.closed || this.quitting || !this.localEntry || !busy) return Promise.resolve(true)
		this.exitGate?.(false)
		return new Promise<boolean>((resolve) => {
			if (this.hidden) this.openWorkspaces()
			else this.dismiss()
			this.exitGate = resolve
			this.confirm = 'quit'
			this.router.capture(true)
			this.requestRender()
		})
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

	/** A workspace in the focused pane's folder, started on the same account. */
	private newWorkspaceHere(): void {
		const entry = this.roster.selected
		const cwd = entry ? this.roster.workspaceOf(entry).cwd : this.options.folder.cwd
		this.newWorkspaceIn(cwd)
	}

	/** A new workspace in a folder, its first session on the account the focused pane runs on. */
	private newWorkspaceIn(cwd: string): void {
		const entry = this.roster.selected
		const workspace = this.roster.addWorkspace(cwd, basename(cwd) || cwd)
		const created = this.newTabIn(workspace)
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
		this.settleExit(false)
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
		this.startIn(this.roster.workspaceOf(entry), undefined, false)
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
			const entry = target.workspace.activeTab?.focus ?? this.roster.entriesOf(target.workspace)[0]
			if (entry) this.open(entry)
		}
	}

	private confirmKey(key: NavKey): void {
		const confirmed = this.confirm
		if (!confirmed) return
		this.confirm = undefined
		const yes = key.kind === 'enter' || (key.kind === 'char' && key.char === 'y')
		// A conversation ending asked: the answer goes back to it, and its end hangs the others up.
		if (this.exitGate) {
			this.settleExit(yes)
			this.router.capture(this.captured())
			return
		}
		if (yes) this.perform(confirmed)
	}

	private settleExit(leave: boolean): void {
		const gate = this.exitGate
		this.exitGate = undefined
		gate?.(leave)
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
					: (target.workspace.activeTab?.focus ?? this.roster.entriesOf(target.workspace)[0])
		if (!entry || !item) return
		this.show(entry)
		const shown = this.roster.workspaceOf(entry)
		if (item === 'Rename') {
			if (target.kind === 'workspace') this.askName('rename-workspace', shown.name)
			else if (target.kind === 'tab') this.askName('rename-tab', this.shownTabLabel())
			else this.askName('rename-session', entry.label)
		} else if (item === 'New tab') this.newTab()
		else if (item === 'Split right') this.splitFocused('side')
		else if (item === 'Split down') this.splitFocused('stack')
		else if (item === 'Zoom') this.toggleZoom()
		else if (target.kind === 'workspace') this.confirm = 'close-workspace'
		else if (target.kind === 'tab') this.closeTabOrWorkspace()
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
		if (key.kind === 'up' || c === 'k') this.stepSession(-1)
		else if (key.kind === 'down' || c === 'j') this.stepSession(1)
		else if (key.kind === 'right' || c === 'l') this.openFull()
		else if (key.kind === 'tab') this.cyclePane(1)
		else if (key.kind === 'backtab') this.cyclePane(-1)
		// Control-C is how a conversation is left; with the sidebar focused it asks to quit them all.
		else if (c === CLEAR) this.askQuit()
	}

	/** Moves the selection through the sessions in the order the sidebar lists them; the workspace and its tab follow. */
	private stepSession(delta: number): void {
		const entry = this.roster.selected
		if (!entry) return
		const list = agentList(this.roster, this.order)
		const at = list.indexOf(entry)
		const next = list[Math.max(0, Math.min(list.length - 1, at + delta))]
		if (!next || next === entry) return
		this.show(next)
		// On the workspaces screen reached from a conversation the right side is live, so the tab shown is started.
		if (this.options.local) this.startShown()
		this.requestRender()
	}

	/** Opens the selected session full screen: the running conversation natively, a child on the whole terminal. */
	private openFull(): void {
		const entry = this.roster.selected
		if (!entry) return
		if (entry.child?.local) {
			this.openNative()
			return
		}
		this.ensureStarted(entry)
		if (!entry.child) return
		this.view = 'full'
		this.router.focus()
		this.fit()
		this.writer.invalidate()
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
		if (room < least * 2 + SPLIT_GAP) {
			this.notice = 'There is not enough room to split this pane.'
			return
		}
		const created = this.addEntry(this.roster.workspaceOf(entry))
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
		const workspace = this.roster.workspaceOf(entry)
		const at = workspace.activeTab ? workspace.tabs.indexOf(workspace.activeTab) : 0
		this.gotoTab((at + delta + workspace.tabs.length) % workspace.tabs.length)
	}

	private gotoTab(index: number): void {
		const entry = this.roster.selected
		if (!entry) return
		const tab = this.roster.workspaceOf(entry).tabs[index]
		if (tab) this.open(tab.focus)
	}

	/** Closes the focused pane; the last pane of a tab closes the tab, and of a workspace's only tab asks to close the workspace. */
	private closePane(): void {
		const entry = this.roster.selected
		const tab = this.roster.shownTab
		if (!entry || !tab) return
		if (leaves(tab.root).length > 1 || this.roster.workspaceOf(entry).tabs.length > 1) {
			this.closeEntries([entry])
			return
		}
		this.confirm = 'close-workspace'
	}

	/** Closes a tab; a workspace's only tab closes the workspace, after asking. */
	private closeTabOrWorkspace(): void {
		const entry = this.roster.selected
		if (entry && this.roster.workspaceOf(entry).tabs.length > 1) this.closeTab()
		else this.confirm = 'close-workspace'
	}

	private closeTab(): void {
		const entry = this.roster.selected
		const tab = this.roster.shownTab
		if (!entry || !tab) return
		if (this.roster.workspaceOf(entry).tabs.length <= 1) {
			this.notice = 'A workspace keeps at least one tab.'
			return
		}
		this.closeEntries(leaves(tab.root))
	}

	/** Starts a session in a new tab of the shown workspace, asking which account first when there is a choice. */
	private newTab(): void {
		const entry = this.roster.selected
		if (!entry) return
		const workspace = this.roster.workspaceOf(entry)
		let accounts: readonly HostAccount[] = []
		try {
			accounts = (this.options.accounts?.() ?? []).filter((a) => a.label !== 'default')
		} catch {
			accounts = []
		}
		if (accounts.length === 0) {
			this.startIn(workspace, undefined)
			return
		}
		const choices = [
			{ id: undefined, text: 'Usual sign-in' },
			...accounts.map((a) => ({
				id: a.id as string | undefined,
				text: `${a.label}  ${a.provider}`,
			})),
		]
		const remembered = choices.findIndex(
			(c) => c.id !== undefined && c.id === workspace.lastAccount,
		)
		this.picker = { workspace, choices, index: Math.max(0, remembered) }
	}

	private startIn(workspace: Workspace, account: string | undefined, ask = true): void {
		if (account === undefined) delete workspace.lastAccount
		else workspace.lastAccount = account
		const created = this.newTabIn(workspace)
		if (account !== undefined) created.pickedAccount = account
		this.open(created)
		// A new tab asks for its name; leaving it empty keeps the number.
		if (ask) {
			this.prompt = { kind: 'rename-tab', value: '', fresh: true }
			this.router.capture(true)
		}
	}

	/** Moves among the workspaces, showing each one's tab without starting what it holds. */
	private stepWorkspace(delta: number): void {
		const entry = this.roster.selected
		if (!entry) return
		const index = this.roster.workspaces.indexOf(this.roster.workspaceOf(entry)) + delta
		const workspace = this.roster.workspaces[index]
		const target = workspace?.activeTab?.focus
		if (target) this.show(target)
	}

	private gotoWorkspace(index: number): void {
		const target = this.roster.workspaces[index]?.activeTab?.focus
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
			this.startIn(picker.workspace, picker.choices[picker.index]?.id)
		}
	}

	private askFolder(): void {
		this.prompt = { kind: 'folder', value: '' }
	}

	private askName(kind: 'rename-session' | 'rename-workspace' | 'rename-tab', value: string): void {
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
		if (prompt.kind === 'folder' || prompt.kind === 'new-workspace') {
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
			if (prompt.kind === 'new-workspace') this.newWorkspaceIn(path)
			else this.openFolder(path)
			return
		}
		const entry = this.roster.selected
		const tab = this.roster.shownTab
		if (entry) {
			if (prompt.kind === 'rename-session' && value !== '') entry.label = value
			else if (prompt.kind === 'rename-workspace' && value !== '')
				this.roster.workspaceOf(entry).name = value
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
			? this.roster.workspaceOf(this.roster.selected).cwd
			: this.options.folder.cwd
		return isAbsolute(full) ? resolve(full) : resolve(base, full)
	}

	/** Opens a folder as a workspace, or shows the workspace it already is. */
	private openFolder(path: string): void {
		const known = this.roster.workspaces.find((s) => s.cwd === path)
		if (known) {
			const entry = known.activeTab?.focus ?? this.roster.entriesOf(known)[0]
			if (entry) this.open(entry)
			return
		}
		const workspace = this.roster.addWorkspace(path, basename(path) || path)
		this.open(this.newTabIn(workspace))
	}

	private perform(what: Confirm): void {
		const entry = this.roster.selected
		if (what === 'quit') {
			this.quit()
			return
		}
		if (!entry) return
		this.closeEntries(this.roster.entriesOf(this.roster.workspaceOf(entry)))
	}

	/** Ends the sessions and takes their panes away; closing the last one leaves nothing to bring back and quits. */
	private closeEntries(doomed: readonly Entry[]): void {
		if (doomed.length < this.roster.entries.length && doomed.some((entry) => entry.child?.local)) {
			this.notice = 'This is the session you started from. End it with /exit.'
			return
		}
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
		// With only the wheel asked for, a terminal that reports more is not acted on.
		if (this.mouseMode === 'scroll' && event.kind !== 'wheel-up' && event.kind !== 'wheel-down')
			return
		if (event.kind === 'press') this.clearSelect()
		if (event.kind === 'drag' && this.select?.pressing) {
			this.dragSelect(event)
			return
		}
		if (event.kind === 'release') {
			this.finishSelect()
			this.endDrags()
		}
		if (this.captured()) {
			this.overlayMouse(event)
			return
		}
		const layout = this.layout()
		if (this.view === 'full') {
			const entry = this.roster.selected
			const whole = this.placement()?.panes[0]
			if (event.kind === 'press' && whole) this.beginSelect(whole, event)
			if (entry && (event.kind === 'wheel-up' || event.kind === 'wheel-down')) {
				const size = entry.child?.screen.scrollbackSize() ?? 0
				const direction = event.kind === 'wheel-up' ? -1 : 1
				entry.scrollBack = Math.max(0, Math.min(size, entry.scrollBack - direction * WHEEL_ROWS))
				this.requestRender()
			}
			return
		}
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
			if (this.reorder) this.dragWorkspace(layout, event)
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
		this.panePress(event)
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
		else if (target?.kind === 'workspace') {
			this.reorder = {
				workspace: target.workspace,
				to: this.roster.workspaces.indexOf(target.workspace),
			}
			this.gotoWorkspace(this.roster.workspaces.indexOf(target.workspace))
			const shown = this.roster.selected
			if (shown) this.open(shown)
		} else if (target?.kind === 'new') this.newWorkspaceHere()
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

	/** A pointer button went up: a drag of a border, the sidebar or a workspace ends, and a moved workspace lands. */
	private endDrags(): void {
		const moved = this.reorder
		if (moved && this.roster.moveWorkspace(moved.workspace, moved.to)) {
			this.revealSelected()
			this.persist()
		}
		if (this.drag || this.sidebarDrag) this.persist()
		this.reorder = undefined
		this.drag = undefined
		this.sidebarDrag = undefined
		this.requestRender()
	}

	/** While a workspace is dragged: the place it would land is the workspace row under the pointer. */
	private dragWorkspace(layout: Layout, event: MouseEvent): void {
		const drag = this.reorder
		if (!drag || !layout.sidebar) return
		const target = hitTest(
			this.sidebarModel(layout.rail),
			layout.sidebar.width,
			layout.sidebar.height,
			Math.min(event.x, layout.sidebar.width - 1),
			event.y,
		)
		if (target?.kind === 'workspace') drag.to = this.roster.workspaces.indexOf(target.workspace)
		else if (!target) {
			// Blank sidebar area under the last workspace row: the workspace goes to the end.
			const geo = geometry(
				layout.sidebar.height,
				this.sidebarModel(layout.rail).foot.length,
				this.split,
				layout.rail,
			)
			const shown = this.roster.workspaces.length - this.sidebarScroll.workspaces
			if (
				event.y >= geo.workspaceTop + shown * geo.workspaceStep &&
				event.y < (geo.footerY ?? geo.ruleY)
			)
				drag.to = this.roster.workspaces.length - 1
		}
		this.requestRender()
	}

	/** A right-click: a menu for the workspace, tab or pane under the pointer. */
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
			if (hit?.kind === 'workspace') target = { kind: 'workspace', workspace: hit.workspace }
			else if (hit?.kind === 'agent') target = { kind: 'pane', entry: hit.entry }
		} else if (layout.tabBar && inRect(layout.tabBar, event.x, event.y)) {
			const entry = this.roster.selected
			const hit = entry
				? tabBarTarget(
						layoutTabBar(this.roster.workspaceOf(entry), layout.tabBar),
						event.x,
						event.y,
					)
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

	/** A press in the pane area: a tab, the "+", a border to drag, or a pane to focus. */
	private panePress(event: MouseEvent): void {
		const layout = this.layout()
		const entry = this.roster.selected
		if (!entry) return
		if (layout.tabBar && inRect(layout.tabBar, event.x, event.y)) {
			const bar = layoutTabBar(this.roster.workspaceOf(entry), layout.tabBar)
			const target = tabBarTarget(bar, event.x, event.y)
			if (target?.kind === 'new') this.newTab()
			else if (target?.kind === 'tab') this.open(target.tab.focus)
			else if (target?.kind === 'previous') this.stepTab(-1)
			else if (target?.kind === 'next') this.stepTab(1)
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
		if (pane) {
			// Focusing a pane keeps the place it was scrolled to: the text to select may be in its history.
			const scrolled = pane.entry.scrollBack
			this.open(pane.entry)
			pane.entry.scrollBack = scrolled
			this.beginSelect(pane, event)
		}
	}

	// --- selecting text --------------------------------------------------------

	/** The cell of the emulator's lines under the pointer, kept inside the pane. */
	private pointAt(entry: Entry, screen: HeadlessScreen, inner: Rect, event: MouseEvent): Point {
		const col = Math.max(0, Math.min(event.x - inner.x, inner.width - 1, screen.cols - 1))
		const row = Math.max(0, Math.min(event.y - inner.y, inner.height - 1))
		return { line: screen.viewTop(entry.scrollBack) + row, col }
	}

	/** A press inside a pane: the anchor of a drag, or at once the word or line a double or triple click names. */
	private beginSelect(pane: { entry: Entry; inner: Rect }, event: MouseEvent): void {
		const { entry, inner } = pane
		const child = entry.child
		if (!child || child.status === 'exited') return
		const inside =
			event.x >= inner.x &&
			event.x < inner.x + inner.width &&
			event.y >= inner.y &&
			event.y < inner.y + inner.height
		if (!inside) return
		const unit = this.clicks.press(event.x, event.y)
		const screen = child.screen
		const point = this.pointAt(entry, screen, inner, event)
		const range: Range =
			unit === 2
				? wordAt(screen, point.line, point.col)
				: unit === 3
					? lineAt(screen, point.line)
					: { start: point, end: point }
		this.select = {
			entry,
			screen,
			cols: screen.cols,
			rows: inner.height,
			inner,
			anchor: range.start,
			focus: range.end,
			unit,
			pressing: true,
			active: unit !== 1,
			copied: false,
		}
		this.requestRender()
	}

	private dragSelect(event: MouseEvent): void {
		const sel = this.select
		if (!sel || sel.unit !== 1) return
		sel.focus = this.pointAt(sel.entry, sel.screen, sel.inner, event)
		if (sel.focus.line !== sel.anchor.line || sel.focus.col !== sel.anchor.col) sel.active = true
		this.requestRender()
	}

	/** The button came up: copy what is highlighted, or forget a plain click. */
	private finishSelect(): void {
		const sel = this.select
		if (!sel?.pressing) return
		sel.pressing = false
		if (!sel.active) {
			this.select = undefined
			return
		}
		if (this.options.copyOnSelect === false) {
			this.note('Selected. Press ctrl+c to copy it, or esc to let go.', undefined)
			return
		}
		this.copySelection(sel)
	}

	private clearSelect(): void {
		if (!this.select) return
		this.select = undefined
		this.requestRender()
	}

	private copySelection(sel: PaneSelection): void {
		const text = extractText(sel.screen, orderRange(sel.anchor, sel.focus))
		const auto = this.options.copyOnSelect !== false
		if (text.trim() === '') {
			if (auto) this.clearSelect()
			return
		}
		sel.copied = true
		// A selection let go of before the tool gets its turn never starts one.
		void this.copier()
			.copy(text, () => !this.closed && this.select === sel)
			.then((outcome) => {
				if (!outcome || this.closed) return
				const { text: message, ok } = describeCopy(
					outcome,
					bypassKey(this.options.env ?? process.env),
				)
				const tip = ok && !this.tipShown && auto
				if (tip) this.tipShown = true
				this.note(
					tip ? `${message} Turn off: tui.copyOnSelect.` : message,
					auto && this.select === sel ? sel : undefined,
					ok ? COPY_NOTE_MS : COPY_ERROR_MS,
				)
			})
	}

	private clipboardCopier: ClipboardCopier | undefined

	/** The one copier for this host, so copies queue behind each other. */
	private copier(): ClipboardCopier {
		this.clipboardCopier ??= createClipboardCopier(
			{ isTTY: true, write: (data) => void this.options.output.write(data) },
			{ ...this.options.clipboard, env: this.options.env ?? process.env },
		)
		return this.clipboardCopier
	}

	/** Says something in the status line; the selection `fading` goes with it. */
	private note(text: string, fading: PaneSelection | undefined, ms?: number): void {
		this.notice = text
		this.cancelNote?.()
		this.cancelNote = undefined
		if (ms !== undefined)
			this.cancelNote = this.schedule(() => {
				this.cancelNote = undefined
				if (this.notice === text) this.notice = undefined
				if (fading && this.select === fading) this.select = undefined
				this.requestRender()
			}, ms)
		this.requestRender()
	}

	/** Ctrl+C copies a selection that was not copied on release; esc, or a second ctrl+c, lets go of it. */
	private selectionKey(chunk: string): boolean {
		const sel = this.select
		if (!sel?.active || sel.pressing || this.options.copyOnSelect !== false) return false
		if (chunk === '\x03' && !sel.copied) this.copySelection(sel)
		else if (chunk === '\x03' || chunk === '\x1b') this.clearSelect()
		else return false
		return true
	}

	/** Gives the terminal a pane's clipboard requests, once per screen. Queries are never answered. */
	private watchClipboard(screen: HeadlessScreen): void {
		if (this.watched.has(screen)) return
		this.watched.add(screen)
		screen.onClipboard((data) => this.forwardClipboard(screen, data))
	}

	private forwardClipboard(screen: HeadlessScreen, data: string): void {
		if (this.closed || this.hidden) return
		const split = data.indexOf(';')
		if (split < 0) return
		const targets = data.slice(0, split)
		let payload = data.slice(split + 1)
		// Only a write to the clipboard: a query would hand the user's clipboard to the program.
		if (!/^[cp]*$/u.test(targets) || !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload)) return
		// Some programs leave the padding off.
		if (payload.length % 4 === 1) return
		if (payload.length % 4 !== 0) payload = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')
		if (payload.length > Math.ceil((MAX_CLIPBOARD_TEXT_BYTES * 4) / 3) + 4) return
		// A session the user cannot see never writes to their clipboard.
		if (!(this.placement()?.panes ?? []).some((p) => p.entry.child?.screen === screen)) {
			this.note(
				'A session that is not on screen asked to copy something. Open it and try again.',
				undefined,
				4000,
			)
			return
		}
		const now = this.options.now ?? Date.now
		const last = this.lastForward.get(screen)
		if (last !== undefined && now() - last < FORWARD_MS) {
			// Too soon after the last one: send this one, the latest, when the pause is over.
			const first = !this.pendingForward.has(screen)
			this.pendingForward.set(screen, data)
			if (first)
				this.schedule(
					() => {
						const held = this.pendingForward.get(screen)
						this.pendingForward.delete(screen)
						this.lastForward.delete(screen)
						if (held !== undefined) this.forwardClipboard(screen, held)
					},
					FORWARD_MS - (now() - last),
				)
			return
		}
		this.lastForward.set(screen, now())
		const text = Buffer.from(payload, 'base64').toString('utf8')
		void this.copier().copy(text, () => !this.closed, { durable: true })
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
				'new-workspace': 'new workspace',
				'rename-session': 'rename pane',
				'rename-workspace': 'rename workspace',
				'rename-tab': prompt.fresh ? 'new tab' : 'rename tab',
			}
			const create = prompt.kind === 'folder' || prompt.kind === 'new-workspace' || prompt.fresh
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
			const workspace = this.roster.workspaceOf(entry)
			const count = this.roster.entriesOf(workspace).length
			return {
				title: 'Close workspace?',
				danger: true,
				lines: [`${workspace.name} — ${count} ${count === 1 ? 'pane' : 'panes'}`],
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
			title: `Start a session in ${picker.workspace.name} on`,
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
				chipBg: this.palette.resize,
				hints: [
					['esc', 'done'],
					['h/l', 'width'],
					['j/k', 'height'],
				],
			}
		if (mode === 'navigate')
			return {
				chip: 'NAVIGATE',
				chipBg: this.palette.navigate,
				hints: [
					['↑/↓', 'session'],
					['→', 'open'],
					['enter', 'type'],
					['tab', 'pane'],
				],
			}
		return {
			chip: 'PREFIX',
			chipBg: this.palette.accent,
			hints: [
				['esc', 'cancel'],
				[prefix, 'send prefix'],
				['w', 'workspace nav'],
				['?', 'keybinds'],
			],
		}
	}

	/**
	 * Draws the mode bar at the right end of `area`, a row that holds no pane cells: the tab bar's
	 * rule. Hints that do not fit are left out, the chip never is.
	 */
	private drawModeBar(frame: Frame, area: Rect, mode: InputMode): void {
		const { palette } = this
		const bar = this.modeBar(mode)
		const chip = ` ${bar.chip} `
		const pieces: { text: string; style: CellStyle }[] = [
			{
				text: chip,
				style: palette.mono
					? { attrs: ATTR_BOLD | ATTR_INVERSE }
					: { fg: palette.ink, bg: bar.chipBg, attrs: ATTR_BOLD },
			},
			{ text: ' ', style: { fg: palette.dim } },
		]
		let width = stringWidth(chip) + 1
		for (const [key, what] of bar.hints) {
			const hint = ` ${what}  `
			if (width + stringWidth(key) + stringWidth(hint) > area.width - 1) break
			pieces.push({ text: key, style: { fg: palette.accent, attrs: ATTR_BOLD } })
			pieces.push({ text: hint, style: { fg: palette.dim } })
			width += stringWidth(key) + stringWidth(hint)
		}
		const used = Math.min(width, area.width)
		let x = area.x + area.width - used
		frame.fillRect({ ...area, x, width: used }, { bg: palette.base })
		for (const piece of pieces) {
			if (x >= area.x + area.width) break
			x += frame.writeText(
				{ ...area, x, width: area.x + area.width - x },
				0,
				piece.text,
				piece.style,
			)
		}
	}

	/** A line of notice at the right end of `area`, in the warning colour. */
	private drawNotice(frame: Frame, area: Rect, notice: string): void {
		const text = ellipsize(` ${notice} `, Math.max(0, area.width - 1))
		const width = stringWidth(text)
		const rect = { ...area, x: area.x + area.width - width, width }
		frame.fillRect(rect, { bg: this.palette.base })
		frame.writeText(rect, 0, text, { fg: this.palette.warn })
	}

	private requestRender(): void {
		if (this.closed || this.hidden || this.pending) return
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
		if (this.closed || this.hidden) return
		const entry = this.roster.selected
		const placement = this.placement()
		const panes = placement?.panes ?? []
		// Every pane on screen settles before it is copied, so none shows a half-written screen.
		await Promise.all(panes.map((p) => p.entry.child?.screen.settled()))
		if (this.closed || this.hidden) return
		const sel = this.select
		if (sel) {
			const here = panes.find((p) => p.entry === sel.entry)
			if (
				!here ||
				here.entry.child?.screen !== sel.screen ||
				sel.screen.cols !== sel.cols ||
				here.inner.height !== sel.rows
			)
				this.select = undefined
			else sel.inner = here.inner
		}
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
		if (entry && this.view === 'split' && layout.tabBar)
			drawTabBar(frame, layout.tabBar, this.roster.workspaceOf(entry), this.palette)
		// The focused pane is drawn last, so the cursor is the one it sets.
		const ordered = [...panes].sort((a, b) => Number(a.entry === entry) - Number(b.entry === entry))
		for (const pane of ordered)
			this.drawPane(frame, pane, pane.entry === entry, placement?.bordered ?? false)
		if (this.reorder) this.drawDrop(frame, layout)
		// The mode bar and a notice go on the tab bar's rule row, never over a pane. A session shown
		// full screen has no tab bar, so they take the screen's last row there.
		const area: Rect =
			layout.tabBar && layout.tabBar.height >= TAB_BAR_HEIGHT
				? { ...layout.main, y: layout.main.y + 1, height: 1 }
				: { ...layout.main, y: layout.main.y + layout.main.height - 1, height: 1 }
		const mode = this.router.current
		const asking = this.captured()
		if (mode !== 'terminal' && !asking) this.drawModeBar(frame, area, mode)
		else if (this.notice && !asking) this.drawNotice(frame, area, this.notice)
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

	/** Reads every workspace's branch now and then again on a timer. */
	private armGit(now = false): void {
		if (this.closed) return
		if (now) this.git.refreshAll(this.roster.workspaces.map((s) => s.cwd))
		this.cancelGit = this.schedule(() => {
			this.git.refreshAll(this.roster.workspaces.map((s) => s.cwd))
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

	/** The line a dragged workspace would land at: under the row above the place it would take. */
	private drawDrop(frame: Frame, layout: Layout): void {
		const drag = this.reorder
		const sidebar = layout.sidebar
		if (!drag || !sidebar) return
		const from = this.roster.workspaces.indexOf(drag.workspace)
		if (drag.to === from) return
		const geo = geometry(sidebar.height, 0, this.split, layout.rail)
		const shown = drag.to - this.sidebarScroll.workspaces
		if (shown < 0 || shown >= geo.workspaceCap) return
		const top = geo.workspaceTop + shown * geo.workspaceStep
		const y = (drag.to < from ? top : top + geo.workspaceStep) - 1
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

	/** Shows the selected cells in reverse video. */
	private paintSelection(frame: Frame, sel: PaneSelection, inner: Rect): void {
		const range = snapRange(sel.screen, orderRange(sel.anchor, sel.focus))
		const top = sel.screen.viewTop(sel.entry.scrollBack)
		for (let row = 0; row < inner.height; row++) {
			const cols = colsOnLine(range, top + row, sel.screen.cols)
			if (!cols) continue
			for (let col = cols[0]; col < Math.min(cols[1], inner.width); col++) {
				const cell = frame.cellAt(inner.x + col, inner.y + row)
				if (cell)
					frame.set(inner.x + col, inner.y + row, { ...cell, attrs: cell.attrs ^ ATTR_INVERSE })
			}
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
		if (bordered) drawBox(frame, outer, focused ? this.palette.focus : this.palette.border)
		const child = entry.child
		if (child) {
			frame.blit(child.screen.cells(entry.scrollBack), inner)
			const sel = this.select
			if (sel?.active && sel.entry === entry && sel.screen === child.screen)
				this.paintSelection(frame, sel, inner)
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
		const workspace = this.roster.workspaceOf(entry)
		const say = (row: number, text: string): void => void frame.writeText(inner, row, text)
		if (entry.folderMissing) {
			say(1, ` The folder for "${entry.label}" was not found.`)
			say(2, ` ${workspace.cwd}`)
			say(3, ' Put it back or remove this workspace, then press enter to try again.')
		} else if (entry.openElsewhere) {
			say(1, ` "${entry.label}" is open in another terminal.`)
			say(2, ' Close it there, then press enter to open it here.')
		} else if (entry.checking) say(1, ` Opening "${entry.label}"...`)
		else {
			say(1, ` "${entry.label}" in ${workspace.name} has not started yet.`)
			say(2, ' Press enter or click it to open it.')
		}
	}

	// --- remembering the layout ------------------------------------------------

	/** What is written between runs: workspaces with their tabs and pane trees, and where focus is. */
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
		const workspaces = this.roster.workspaces.map((workspace) => {
			const active = workspace.activeTab ? workspace.tabs.indexOf(workspace.activeTab) : 0
			return {
				name: workspace.name,
				cwd: workspace.cwd,
				...(workspace.lastAccount ? { lastAccount: workspace.lastAccount } : {}),
				tabs: workspace.tabs.map(saveTab),
				...(active > 0 ? { activeTab: active } : {}),
			}
		})
		const workspace = selected
			? this.roster.workspaces.indexOf(this.roster.workspaceOf(selected))
			: -1
		const sidebar = {
			...(this.sidebar.collapsed ? { collapsed: true as const } : {}),
			...(this.sidebar.width !== SIDEBAR_DEFAULT ? { width: this.sidebar.width } : {}),
			...(this.split !== 0.5 ? { split: this.split } : {}),
			...(this.order !== 'grouped' ? { order: this.order } : {}),
		}
		return {
			version: 3,
			workspaces,
			...(workspace >= 0 ? { focus: { workspace } } : {}),
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
			store.save(this.forgetAll ? { version: 3, workspaces: [] } : this.snapshot())
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
		this.settleExit(true)
		this.cancelKill?.()
		this.cancelNote?.()
		this.cancelPoll?.()
		this.cancelReconcile?.()
		this.cancelGit?.()
		this.stopWatching?.()
		this.pending?.()
		const { input, output } = this.options
		input.off('data', this.onData)
		output.off('resize', this.onResize)
		process.off('exit', this.onProcessExit)
		this.releaseSignals()
		input.setRawMode?.(false)
		input.pause?.()
		if (!this.hidden) output.write(LEAVE_SCREEN)
		for (const child of this.everyChild()) child.dispose()
		this.finish(0)
	}
}
