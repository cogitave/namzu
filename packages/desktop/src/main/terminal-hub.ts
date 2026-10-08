import type { DesktopSettings } from '../shared/settings-protocol.js'
import type {
	TerminalAttachResult,
	TerminalCreateSpec,
	TerminalDataNotification,
	TerminalExitNotification,
	TerminalInfo,
	TerminalStatus,
} from '../shared/terminal-protocol.js'
import {
	type EngineHost,
	type ShellEnvironment,
	type TerminalLaunch,
	type TerminalTabView,
	buildEngineLaunch,
	resolveShell,
	terminalActivity,
	terminalHostId,
	terminalTabId,
} from '../shared/terminal-tabs.js'
import {
	TERMINAL_VIEW_LIMITS,
	type TerminalAttachOptions,
	type TerminalAttachView,
	type TerminalAvailability,
	type TerminalEvent,
	type TerminalOpenRequest,
	type TerminalOpenResult,
} from '../shared/terminal-view.js'
import type { SavedTerminalTab } from './terminal-tab-store.js'

/** The slice of the host's terminal client the hub uses; tests supply a fake. */
export interface HostTerminals {
	status(): Promise<TerminalStatus>
	create(spec: TerminalCreateSpec): Promise<TerminalInfo>
	attach(
		terminalId: string,
		viewerId: string,
		options?: { fromOffset?: number; writer?: boolean; force?: boolean },
	): Promise<TerminalAttachResult>
	detach(terminalId: string, viewerId: string): Promise<void>
	write(terminalId: string, viewerId: string, data: string): Promise<void>
	resize(terminalId: string, viewerId: string, cols: number, rows: number): Promise<void>
	close(terminalId: string): Promise<void>
	nextOffset(terminalId: string): number | undefined
	on(event: 'data', listener: (note: TerminalDataNotification) => void): unknown
	on(event: 'exit', listener: (note: TerminalExitNotification) => void): unknown
	on(event: 'gap', listener: (gap: { terminalId: string }) => void): unknown
	dispose(): void
}

/** One project's host process, as the operator keeps it. */
export interface HubConnection {
	supportsTerminals(): boolean
	request(method: string, params?: Record<string, unknown>): Promise<unknown>
	on(event: 'frame', listener: (frame: Record<string, unknown>) => void): unknown
	on(event: 'closed', listener: () => void): unknown
	off(event: 'frame', listener: (frame: Record<string, unknown>) => void): unknown
}

export interface HubProject {
	id: string
	name: string
	path: string
}

export interface TerminalHubOptions {
	/** The project's running host; throws, in words for the person, when there is none or it is not trusted. */
	projectHost(
		projectId: string,
	):
		| { project: HubProject; connection: HubConnection }
		| Promise<{ project: HubProject; connection: HubConnection }>
	createClient(connection: HubConnection): HostTerminals
	settings(): Pick<DesktopSettings, 'terminalShell' | 'restoreTerminals'>
	shellEnvironment(): ShellEnvironment
	engineHost(): EngineHost
	/** The tab list changed. */
	publish(tabs: TerminalTabView[]): void
	/** Output or an end for the window that has this terminal open. */
	send(windowId: string, event: TerminalEvent): void
	save(tabs: SavedTerminalTab[]): void
	clock: {
		now(): number
		/** Repeats until the returned function is called. */
		every(ms: number, run: () => void): () => void
		/** Runs once, unless the returned function is called first. */
		after(ms: number, run: () => void): () => void
	}
	onError?(error: unknown, operation: string): void
}

interface Entry {
	view: TerminalTabView
	/** Absent once the host process is gone: only the saved screen is left. */
	hostId?: string
	connection?: HubConnection
	client?: HostTerminals
	lastOutputAt?: number
	/** When the person last typed or resized, to tell an echo from work. */
	lastInputAt?: number
	screen: string
	viewers: Map<string, string>
}

/** The observer the hub itself keeps on every terminal, so output and an exit are seen with no view open. */
const OBSERVER = 'desktop'
const SAVE_QUIET_MS = 3_000
/** A terminal that never goes quiet is still saved this often. */
const SAVE_MAX_MS = 12_000
/** Output this soon after typing or a resize is the program echoing, not working. */
const ECHO_MS = 150
const TICK_MS = 1_000

function integer(value: unknown, min: number, max: number, what: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
		throw new Error(`Invalid terminal ${what}.`)
	return value
}

function viewer(value: unknown): string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > TERMINAL_VIEW_LIMITS.maxViewerId
	)
		throw new Error('Invalid terminal view.')
	return value
}

/**
 * Terminal tabs for the whole app. The hosts own the processes; this owns the tabs: which project
 * each belongs to, what its badge says, who is looking, and what it showed last so a restart can
 * bring it back as an ended session.
 */
export class TerminalHub {
	private readonly entries = new Map<string, Entry>()
	private readonly byHost = new Map<string, Entry>()
	private readonly clients = new Map<HubConnection, HostTerminals>()
	private stopTicking: (() => void) | undefined
	private cancelQuiet: (() => void) | undefined
	private cancelMax: (() => void) | undefined
	private closed = false

	constructor(private readonly options: TerminalHubOptions) {}

	list(): TerminalTabView[] {
		return [...this.entries.values()]
			.map((entry) => ({ ...entry.view }))
			.sort((a, b) => a.createdAt - b.createdAt)
	}

	has(tabId: string): boolean {
		return this.entries.has(tabId)
	}

	/**
	 * Take the tabs kept from the last run. Those the layout still holds come back as ended sessions;
	 * the rest are forgotten. Returns the layout's terminal tabs that have nothing behind them, which
	 * the caller takes out of the layout.
	 */
	restore(saved: readonly SavedTerminalTab[], layoutTabs: ReadonlySet<string>): string[] {
		if (this.options.settings().restoreTerminals) {
			for (const tab of saved)
				if (layoutTabs.has(tab.view.id)) this.entries.set(tab.view.id, this.entry(tab))
		}
		const orphans = [...layoutTabs].filter((id) => !this.entries.has(id))
		this.persist()
		return orphans
	}

	private entry(tab: SavedTerminalTab): Entry {
		return { view: { ...tab.view }, screen: tab.screen, viewers: new Map() }
	}

	async availability(projectId: string): Promise<TerminalAvailability> {
		let host: Awaited<ReturnType<TerminalHubOptions['projectHost']>>
		try {
			host = await this.options.projectHost(projectId)
		} catch (error) {
			return { available: false, reason: error instanceof Error ? error.message : String(error) }
		}
		if (!host.connection.supportsTerminals())
			return {
				available: false,
				reason: 'This project runs a Namzu runtime that has no terminals. Update Namzu.',
			}
		try {
			const status = await this.clientFor(host.connection).status()
			return status.available
				? { available: true }
				: { available: false, reason: status.reason ?? 'Terminals are not available here.' }
		} catch (error) {
			return { available: false, reason: error instanceof Error ? error.message : String(error) }
		}
	}

	async open(request: TerminalOpenRequest): Promise<TerminalOpenResult> {
		const cols = integer(
			request.cols,
			TERMINAL_VIEW_LIMITS.minCols,
			TERMINAL_VIEW_LIMITS.maxCols,
			'width',
		)
		const rows = integer(
			request.rows,
			TERMINAL_VIEW_LIMITS.minRows,
			TERMINAL_VIEW_LIMITS.maxRows,
			'height',
		)
		const { project, connection } = await this.options.projectHost(request.projectId)
		if (!connection.supportsTerminals())
			throw new Error('This project runs a Namzu runtime that has no terminals. Update Namzu.')
		let launch: TerminalLaunch
		let omitted: string[] = []
		if (request.kind === 'engine') {
			const built = buildEngineLaunch(
				{
					engine: request.engine,
					provider: request.provider,
					model: request.model,
					effort: request.effort,
					permissionMode: request.permissionMode,
					prompt: request.prompt,
				},
				this.options.engineHost(),
				project,
			)
			launch = built
			omitted = built.omitted
		} else
			launch = resolveShell(this.options.settings().terminalShell, this.options.shellEnvironment())
		const client = this.clientFor(connection)
		const status = await client.status()
		if (!status.available) throw new Error(status.reason ?? 'Terminals are not available here.')
		const info = await client.create({
			cwd: project.path,
			command: launch.command,
			args: launch.args,
			...(launch.env ? { env: launch.env } : {}),
			cols,
			rows,
			title: launch.title,
		})
		const entry: Entry = {
			view: {
				id: terminalTabId(info.id),
				projectId: project.id,
				kind: request.kind,
				...(request.kind === 'engine' ? { engine: request.engine } : {}),
				title: launch.title,
				status: 'running',
				createdAt: info.createdAt,
				...(request.kind === 'engine' ? { activity: 'working' as const } : {}),
			},
			hostId: info.id,
			connection,
			client,
			// Starting is activity: a program that prints before the hub is watching is still starting up.
			lastOutputAt: this.options.clock.now(),
			screen: '',
			viewers: new Map(),
		}
		try {
			// Every output and the exit are seen from here on, whether or not a window is looking.
			await client.attach(info.id, OBSERVER)
		} catch (error) {
			await client.close(info.id).catch(() => undefined)
			throw error
		}
		this.entries.set(entry.view.id, entry)
		this.byHost.set(info.id, entry)
		this.afterChange()
		return { terminal: { ...entry.view }, omitted }
	}

	async attach(
		tabId: string,
		viewerId: string,
		windowId: string,
		options: TerminalAttachOptions = {},
	): Promise<TerminalAttachView> {
		const entry = this.get(tabId)
		const id = viewer(viewerId)
		if (!entry.client || !entry.hostId) {
			entry.viewers.set(id, windowId)
			return this.savedScreen(entry)
		}
		// Registered first: output that follows the answer must reach this view.
		const known = entry.viewers.has(id)
		entry.viewers.set(id, windowId)
		try {
			const result = await entry.client.attach(entry.hostId, id, {
				...(options.fromOffset === undefined ? {} : { fromOffset: options.fromOffset }),
				...(options.writer ? { writer: true } : {}),
				...(options.force ? { force: true } : {}),
			})
			if (result.terminal.status === 'exited') this.noteExit(entry, result.terminal.exitCode)
			return {
				mode: result.mode,
				screen: result.screen,
				data: result.data,
				start: result.start,
				end: result.end,
				writer: result.writer,
				truncated: result.truncated,
				status: entry.view.status,
				...(entry.view.exitCode === undefined ? {} : { exitCode: entry.view.exitCode }),
			}
		} catch (error) {
			if (!known) entry.viewers.delete(id)
			throw error
		}
	}

	private savedScreen(entry: Entry): TerminalAttachView {
		return {
			mode: 'snapshot',
			screen: entry.screen,
			data: '',
			start: 0,
			end: 0,
			writer: false,
			truncated: false,
			status: entry.view.status === 'running' ? 'restored' : entry.view.status,
			...(entry.view.exitCode === undefined ? {} : { exitCode: entry.view.exitCode }),
		}
	}

	/**
	 * A window that reloaded, navigated or closed no longer has its views. Without this the host keeps
	 * counting the old view as the one at the keyboard, and the new page cannot type.
	 */
	releaseWindow(windowId: string): void {
		for (const entry of this.entries.values()) {
			for (const [id, owner] of [...entry.viewers]) {
				if (owner !== windowId) continue
				entry.viewers.delete(id)
				if (entry.client && entry.hostId)
					void entry.client.detach(entry.hostId, id).catch(() => undefined)
			}
		}
	}

	async detach(tabId: string, viewerId: string, windowId: string): Promise<void> {
		const entry = this.get(tabId)
		const id = viewer(viewerId)
		if (entry.viewers.get(id) !== windowId) return
		entry.viewers.delete(id)
		if (entry.client && entry.hostId)
			await entry.client.detach(entry.hostId, id).catch(() => undefined)
	}

	async write(tabId: string, viewerId: string, windowId: string, data: string): Promise<void> {
		const { entry, id } = this.view(tabId, viewerId, windowId)
		if (
			typeof data !== 'string' ||
			data.length === 0 ||
			data.length > TERMINAL_VIEW_LIMITS.maxWrite
		)
			throw new Error('Invalid terminal input.')
		if (!entry.client || !entry.hostId) throw new Error('That terminal has ended.')
		entry.lastInputAt = this.options.clock.now()
		await entry.client.write(entry.hostId, id, data)
	}

	async resize(
		tabId: string,
		viewerId: string,
		windowId: string,
		cols: number,
		rows: number,
	): Promise<void> {
		const { entry, id } = this.view(tabId, viewerId, windowId)
		const width = integer(cols, TERMINAL_VIEW_LIMITS.minCols, TERMINAL_VIEW_LIMITS.maxCols, 'width')
		const height = integer(
			rows,
			TERMINAL_VIEW_LIMITS.minRows,
			TERMINAL_VIEW_LIMITS.maxRows,
			'height',
		)
		if (!entry.client || !entry.hostId) return
		entry.lastInputAt = this.options.clock.now()
		await entry.client.resize(entry.hostId, id, width, height)
	}

	private view(tabId: string, viewerId: string, windowId: string) {
		const entry = this.get(tabId)
		const id = viewer(viewerId)
		if (entry.viewers.get(id) !== windowId)
			throw new Error('This window has not opened that terminal.')
		return { entry, id }
	}

	/** End the tab's process tree and forget the tab. */
	async close(tabId: string): Promise<void> {
		const entry = this.entries.get(tabId)
		if (!entry) return
		this.entries.delete(tabId)
		if (entry.hostId) this.byHost.delete(entry.hostId)
		entry.viewers.clear()
		try {
			if (entry.client && entry.hostId) await entry.client.close(entry.hostId)
		} catch (error) {
			this.options.onError?.(error, 'terminal.close')
		} finally {
			this.afterChange()
		}
	}

	/** Every terminal of a project, for when the project goes away. Returns the closed tab ids. */
	async closeProject(projectId: string): Promise<string[]> {
		const tabs = [...this.entries.values()]
			.filter((entry) => entry.view.projectId === projectId)
			.map((entry) => entry.view.id)
		await Promise.all(tabs.map((tab) => this.close(tab)))
		return tabs
	}

	/** Stop listening and keep what is kept. The hosts end their terminals with their own process. */
	async shutdown(): Promise<void> {
		this.closed = true
		this.stopTicking?.()
		this.cancelQuiet?.()
		this.cancelMax?.()
		await this.snapshots()
		this.persist()
		for (const client of this.clients.values()) client.dispose()
		this.clients.clear()
	}

	private get(tabId: string): Entry {
		terminalHostId(tabId)
		const entry = this.entries.get(tabId)
		if (!entry) throw new Error('That terminal is not open.')
		return entry
	}

	private clientFor(connection: HubConnection): HostTerminals {
		const known = this.clients.get(connection)
		if (known) return known
		const client = this.options.createClient(connection)
		this.clients.set(connection, client)
		client.on('data', (note) => this.onData(note))
		client.on('exit', (note) => this.onExit(note))
		client.on('gap', (gap) => this.onGap(client, gap.terminalId))
		connection.on('closed', () => this.onConnectionClosed(connection))
		return client
	}

	private onData(note: TerminalDataNotification): void {
		const entry = this.byHost.get(note.terminalId)
		if (!entry) return
		const now = this.options.clock.now()
		if (entry.lastInputAt === undefined || now - entry.lastInputAt >= ECHO_MS)
			entry.lastOutputAt = now
		this.send(entry, { kind: 'data', tabId: entry.view.id, offset: note.offset, data: note.data })
		this.scheduleSave()
		if (entry.view.kind === 'engine') this.refreshActivity()
	}

	private onExit(note: TerminalExitNotification): void {
		const entry = this.byHost.get(note.terminalId)
		if (!entry) return
		this.noteExit(entry, note.exitCode)
		this.send(entry, {
			kind: 'exit',
			tabId: entry.view.id,
			exitCode: note.exitCode,
			...(note.signal === undefined ? {} : { signal: note.signal }),
		})
		void this.snapshot(entry).then(() => this.persist())
	}

	private noteExit(entry: Entry, exitCode: number | undefined): void {
		if (entry.view.status === 'exited') return
		entry.view.status = 'exited'
		if (exitCode !== undefined) entry.view.exitCode = exitCode
		if (entry.view.kind === 'engine') entry.view.activity = 'exited'
		this.afterChange()
	}

	/** The hub's own view dropped output: continue from where it is, so nothing is skipped for later views. */
	private onGap(client: HostTerminals, hostId: string): void {
		const entry = this.byHost.get(hostId)
		if (!entry) return
		void client
			.attach(hostId, OBSERVER, { fromOffset: client.nextOffset(hostId) })
			.catch((error) => this.options.onError?.(error, 'terminal.regap'))
	}

	private onConnectionClosed(connection: HubConnection): void {
		this.clients.get(connection)?.dispose()
		this.clients.delete(connection)
		let changed = false
		for (const entry of this.entries.values()) {
			if (entry.connection !== connection) continue
			if (entry.hostId) this.byHost.delete(entry.hostId)
			if (entry.view.status === 'running') {
				entry.view.status = 'exited'
				if (entry.view.kind === 'engine') entry.view.activity = 'exited'
				this.send(entry, { kind: 'exit', tabId: entry.view.id })
			}
			entry.hostId = undefined
			entry.client = undefined
			entry.connection = undefined
			changed = true
		}
		if (changed && !this.closed) this.afterChange()
	}

	private send(entry: Entry, event: TerminalEvent): void {
		for (const windowId of new Set(entry.viewers.values())) this.options.send(windowId, event)
	}

	private afterChange(): void {
		this.options.publish(this.list())
		this.persist()
		this.syncTicker()
	}

	private syncTicker(): void {
		const needed = [...this.entries.values()].some(
			(entry) => entry.view.kind === 'engine' && entry.view.status === 'running',
		)
		if (needed && !this.stopTicking && !this.closed)
			this.stopTicking = this.options.clock.every(TICK_MS, () => this.refreshActivity())
		else if (!needed && this.stopTicking) {
			this.stopTicking()
			this.stopTicking = undefined
		}
	}

	private refreshActivity(): void {
		const now = this.options.clock.now()
		let changed = false
		for (const entry of this.entries.values()) {
			if (entry.view.kind !== 'engine') continue
			const next = terminalActivity({
				status: entry.view.status,
				lastOutputAt: entry.lastOutputAt,
				now,
			})
			if (entry.view.activity !== next) {
				entry.view.activity = next
				changed = true
			}
		}
		if (changed) this.options.publish(this.list())
	}

	/** Nothing is kept while the setting is off: a screen can hold a secret the person typed or printed. */
	private saved(): SavedTerminalTab[] {
		if (!this.options.settings().restoreTerminals) return []
		return [...this.entries.values()].map((entry) => ({
			view: { ...entry.view },
			screen: entry.screen,
		}))
	}

	private persist(): void {
		this.options.save(this.saved())
	}

	/** Output keeps the saved screen current, a little after it goes quiet. */
	private scheduleSave(): void {
		if (!this.options.settings().restoreTerminals) return
		this.cancelQuiet?.()
		this.cancelQuiet = this.options.clock.after(SAVE_QUIET_MS, () => this.saveNow())
		// A program that prints without pause never reaches the quiet; this bounds the wait.
		this.cancelMax ??= this.options.clock.after(SAVE_MAX_MS, () => this.saveNow())
	}

	/** "Bring terminal tabs back" changed: off removes what was kept, on starts keeping it. */
	settingsChanged(): void {
		if (this.closed) return
		if (this.options.settings().restoreTerminals) this.saveNow()
		else {
			this.cancelQuiet?.()
			this.cancelMax?.()
			this.cancelQuiet = undefined
			this.cancelMax = undefined
			this.persist()
		}
	}

	private saveNow(): void {
		this.cancelQuiet?.()
		this.cancelMax?.()
		this.cancelQuiet = undefined
		this.cancelMax = undefined
		void this.snapshots().then(() => this.persist())
	}

	private async snapshots(): Promise<void> {
		if (!this.options.settings().restoreTerminals) return
		await Promise.all([...this.entries.values()].map((entry) => this.snapshot(entry)))
	}

	private async snapshot(entry: Entry): Promise<void> {
		if (!entry.client || !entry.hostId) return
		try {
			const result = await entry.client.attach(entry.hostId, OBSERVER)
			entry.screen = result.screen + result.data
		} catch {
			// The last screen saved stays.
		}
	}
}
