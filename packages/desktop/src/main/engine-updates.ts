import { posix, win32 } from 'node:path'
import {
	ENGINE_UPDATE_IDS,
	ENGINE_UPDATE_NAMES,
	ENGINE_UPDATE_PACKAGES,
	type EngineInstallMethod,
	type EngineUpdateAnnouncement,
	type EngineUpdateId,
	type EngineUpdateItem,
	type EngineUpdateNotice,
	type EngineUpdateResult,
	type EngineUpdateStatus,
	type EngineUpdatesState,
	REGISTRY_STALE_MS,
	compareVersions,
} from '../shared/engine-update-protocol.js'
import { checkIntervalMs, firstCheckDelayMs } from './updater.js'

/* ------------------------------------------------------------------ where a program is */

export interface InstallContext {
	platform: NodeJS.Platform
	home: string
	/** `%APPDATA%` on Windows. */
	appData?: string
	/** Where npm keeps global programs, when the environment names it. */
	npmPrefix?: string
}

const NPM_DIRECTORIES: Record<EngineUpdateId, string> = {
	'codex-cli': '/node_modules/@openai/codex',
	'claude-code': '/node_modules/@anthropic-ai/claude-code',
	'namzu-cli': '/node_modules/@namzu/cli',
}

function slashes(path: string, windows: boolean): string {
	const flat = path.replaceAll('\\', '/')
	return windows ? flat.toLowerCase() : flat
}

/**
 * How a program got onto the machine, read only from where it is. Anything else (Homebrew, winget,
 * scoop, a download) is `unknown`: Namzu never guesses a package manager.
 */
export function classifyInstall(
	id: EngineUpdateId,
	found: { path: string; realPath?: string; shimText?: string },
	context: InstallContext,
): EngineInstallMethod {
	const windows = context.platform === 'win32'
	const places = [found.path, found.realPath]
		.filter((place): place is string => typeof place === 'string' && place.length > 0)
		.map((place) => slashes(place, windows))
	const marker = NPM_DIRECTORIES[id]
	if (places.some((place) => place.includes(marker))) return 'npm-global'
	// An npm shim on Windows is a small script that names the package it starts, wherever the prefix is.
	if (found.shimText && slashes(found.shimText, windows).includes(marker)) return 'npm-global'
	const under = (directory: string | undefined, place: string): boolean => {
		if (!directory) return false
		const base = slashes(directory, windows).replace(/\/+$/u, '')
		return place.startsWith(`${base}/`)
	}
	if (
		windows &&
		places.some((place) => under(context.appData && win32.join(context.appData, 'npm'), place))
	)
		return 'npm-global'
	if (
		!windows &&
		context.npmPrefix &&
		places.some((place) => under(`${context.npmPrefix}/bin`, place))
	)
		return 'npm-global'
	const home = context.home
	if (
		id === 'claude-code' &&
		places.some((place) => under((windows ? win32 : posix).join(home, '.local', 'bin'), place))
	)
		return 'native'
	if (id === 'codex-cli' && places.some((place) => place.includes('/.codex/packages/')))
		return 'standalone'
	return 'unknown'
}

/** What a click runs (or what to run by hand), without any path: the line a person reads. */
export function updateCommandText(id: EngineUpdateId, method: EngineInstallMethod): string {
	if (method === 'npm-global' || id === 'namzu-cli')
		return `npm install -g ${ENGINE_UPDATE_PACKAGES[id]}@latest`
	return id === 'claude-code' ? 'claude update' : 'codex update'
}

const METHOD_NOTES: Record<EngineInstallMethod, string> = {
	'npm-global': 'Installed with npm',
	native: 'Installed by its own installer',
	standalone: 'Standalone install',
	bundled: 'Bundled with Namzu Desktop, so it updates with the app.',
	unknown:
		'Namzu can’t tell how this was installed, so it won’t run the update. Run this in a terminal:',
}

/** Characters Command Prompt reads as syntax inside a `/c` line. */
const CMD_SYNTAX = /[&|<>^%"!`\r\n\0]/u

export interface EngineLaunchSpec {
	command: string
	args: string[]
	title: string
}

/** The program and arguments of an update, shaped for the platform. Undefined when it cannot run safely. */
export function updateLaunch(input: {
	id: EngineUpdateId
	method: EngineInstallMethod
	program?: { path: string; shim: boolean }
	npm?: { path: string; shim: boolean }
	platform: NodeJS.Platform
	commandPrompt?: string
	/** The registry the check used: what was offered is what is installed. */
	registry?: string
}): EngineLaunchSpec | undefined {
	const title = `Updating ${ENGINE_UPDATE_NAMES[input.id]}`
	let target: { path: string; shim: boolean } | undefined
	let args: string[]
	if (input.method === 'npm-global') {
		target = input.npm
		args = [
			'install',
			'-g',
			...(input.registry ? [`--registry=${input.registry}`] : []),
			`${ENGINE_UPDATE_PACKAGES[input.id]}@latest`,
		]
	} else if (input.method === 'native' || input.method === 'standalone') {
		target = input.program
		args = ['update']
	} else return undefined
	if (!target) return undefined
	if (input.platform === 'win32' && target.shim) {
		const parts = [target.path, ...args]
		if (parts.some((part) => CMD_SYNTAX.test(part))) return undefined
		return {
			command: input.commandPrompt ?? 'cmd.exe',
			args: ['/d', '/c', 'call', ...parts],
			title,
		}
	}
	return { command: target.path, args, title }
}

/* ------------------------------------------------------------------ the cache on disk */

export interface EngineUpdateCache {
	/** The registry's latest per program and when it said so. */
	latest: Partial<Record<EngineUpdateId, { version: string; checkedAt: number }>>
	/** The version the person was last told about, so one version is announced once. */
	announced: Partial<Record<EngineUpdateId, string>>
}

export const emptyCache = (): EngineUpdateCache => ({ latest: {}, announced: {} })

export interface Inspection {
	path?: string
	realPath?: string
	installed?: string
	method: EngineInstallMethod
	missing?: boolean
	bundled?: boolean
}

/** Why the last update stopped, from the end of the terminal's output. */
export function failureText(
	id: EngineUpdateId,
	platform: NodeJS.Platform,
	tail: string | undefined,
): string {
	const name = ENGINE_UPDATE_NAMES[id]
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escape sequences is the point.
	const plain = (tail ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
	if (
		platform === 'win32' &&
		/EBUSY|EPERM|resource busy|being used by another process/iu.test(plain)
	)
		return `${name} could not be replaced because it is still open. Close other ${name} windows, and any ${name} conversation or terminal tab in Namzu, then try again.`
	if (/EACCES|permission denied|administrator/iu.test(plain))
		return `${name} could not be updated: npm cannot write to its folder. Run the command in a terminal opened as administrator, or fix the folder’s permissions.`
	return `${name} update failed. The terminal tab shows why.`
}

/* ------------------------------------------------------------------ the controller */

export interface EngineUpdatesDeps {
	platform: NodeJS.Platform
	install: InstallContext
	/** Where a program is over PATH and the places a person's tools land. */
	find(name: 'codex' | 'claude' | 'namzu' | 'npm'): { path: string; shim: boolean } | undefined
	realPath(path: string): string | undefined
	/** The first bytes of a program's file when it is a small script (an npm shim), to read what it starts. */
	shimText?(path: string): string | undefined
	/** `--version` of a program, run directly with a short timeout; undefined when it cannot be read. */
	version(program: { path: string; shim: boolean }): Promise<string | undefined>
	/** The registry's `latest` for a package; undefined when offline or the answer is not a version. */
	latest(pkg: string): Promise<string | undefined>
	/** The bundled command line's version, when the app carries one. */
	bundledVersion(): string | undefined
	commandPrompt?: string
	/** The registry the checks use; an npm update installs from the same one. */
	registry?: string
	cache: { read(): EngineUpdateCache; write(cache: EngineUpdateCache): void }
	clock: {
		now(): number
		after(ms: number, run: () => void): () => void
		every(ms: number, run: () => void): () => void
	}
	firstCheckDelayMs?: number
	/** Why an update must wait right now, in words for the person. */
	blocker(id: EngineUpdateId): string | undefined
	/** Ends the idle servers Namzu itself keeps for this engine. */
	stopServers(id: EngineUpdateId): Promise<void>
	/** Starts the command in a visible terminal tab and says which one. */
	open(context: EngineUpdateContext, launch: EngineLaunchSpec): Promise<{ tabId: string }>
	/** The engine changed on disk: its stored model lists are no longer true. */
	updated(id: EngineUpdateId): void
	/** The update succeeded and its terminal has nothing left to show: close its tab. */
	finished?(tabId: string): void
	broadcast(state: EngineUpdatesState): void
	notice(windowId: string | undefined, notice: EngineUpdateNotice): void
	record(event: string, details?: Record<string, unknown>): void
}

/** What the caller of an update owns: the window that asked and where the terminal goes. */
export interface EngineUpdateContext {
	windowId?: string
	groupId: string
	projectId?: string
}

interface Operation {
	tabId: string
	windowId?: string
	from?: string
}

/**
 * Finds out whether the two external engines and a standalone Namzu CLI are behind the registry, and
 * on a click runs the update in a terminal tab the person can watch. It never installs by itself,
 * never updates while that program is working, and treats every error as quiet.
 */
export class EngineUpdates {
	private readonly inspections = new Map<EngineUpdateId, Inspection>()
	private readonly failures = new Map<EngineUpdateId, string>()
	private readonly operations = new Map<EngineUpdateId, Operation>()
	/** Updates between the click and the terminal opening; they already own the one update slot. */
	private readonly starting = new Set<EngineUpdateId>()
	private readonly justUpdated = new Set<EngineUpdateId>()
	private cache: EngineUpdateCache
	private checking = false
	private checkedAt?: number
	private cancelFirst?: () => void
	private cancelEvery?: () => void
	private started = false
	private running?: Promise<void>

	constructor(private readonly deps: EngineUpdatesDeps) {
		this.cache = deps.cache.read()
		for (const entry of Object.values(this.cache.latest))
			if (entry && (this.checkedAt === undefined || entry.checkedAt > this.checkedAt))
				this.checkedAt = entry.checkedAt
	}

	/** Reads what is installed now, then checks the registry after a short delay and every few hours. */
	start(): void {
		if (this.started) return
		this.started = true
		void this.inspectAll().then(() => this.publish())
		this.cancelFirst = this.deps.clock.after(
			this.deps.firstCheckDelayMs ?? firstCheckDelayMs,
			() => void this.scheduled(),
		)
		this.cancelEvery = this.deps.clock.every(checkIntervalMs, () => void this.check())
	}

	dispose(): void {
		this.cancelFirst?.()
		this.cancelEvery?.()
		this.cancelFirst = undefined
		this.cancelEvery = undefined
	}

	/** The first check after launch asks the registry only when the cache is older than a check interval. */
	private async scheduled(): Promise<void> {
		const now = this.deps.clock.now()
		const fresh = ENGINE_UPDATE_IDS.every((id) => {
			const entry = this.cache.latest[id]
			return entry !== undefined && now - entry.checkedAt < checkIntervalMs
		})
		if (fresh) {
			await this.inspectAll()
			this.publish()
			return
		}
		await this.check()
	}

	state(): EngineUpdatesState {
		return {
			items: ENGINE_UPDATE_IDS.map((id) => this.item(id)),
			checking: this.checking,
			...(this.checkedAt === undefined ? {} : { checkedAt: this.checkedAt }),
		}
	}

	/** A manual or scheduled check of all three. One at a time. */
	check(): Promise<void> {
		if (this.running) return this.running
		const run = this.checkNow().finally(() => {
			this.running = undefined
		})
		this.running = run
		return run
	}

	private async checkNow(): Promise<void> {
		this.checking = true
		this.publish()
		try {
			await this.inspectAll()
			const now = this.deps.clock.now()
			let reached = false
			await Promise.all(
				ENGINE_UPDATE_IDS.map(async (id) => {
					try {
						const version = await this.deps.latest(ENGINE_UPDATE_PACKAGES[id])
						if (!version) return
						reached = true
						this.cache.latest[id] = { version, checkedAt: now }
					} catch (error) {
						// Offline is not news: the last answer stays and nothing is shown.
						this.deps.record('engine_update_check_failed', { id, error })
					}
				}),
			)
			if (reached) {
				this.checkedAt = now
				this.deps.cache.write(this.cache)
			}
			// A program that is current again no longer carries an old failure.
			for (const id of ENGINE_UPDATE_IDS) {
				if (this.operations.has(id)) continue
				const item = this.item(id, true)
				if (item.status === 'current') this.failures.delete(id)
			}
		} finally {
			this.checking = false
			this.publish()
		}
	}

	private async inspectAll(): Promise<void> {
		await Promise.all(ENGINE_UPDATE_IDS.map((id) => this.inspect(id)))
	}

	private async inspect(id: EngineUpdateId): Promise<void> {
		const program = this.deps.find(
			id === 'codex-cli' ? 'codex' : id === 'claude-code' ? 'claude' : 'namzu',
		)
		if (!program) {
			if (id === 'namzu-cli') {
				const bundled = this.deps.bundledVersion()
				this.inspections.set(id, {
					method: 'bundled',
					bundled: true,
					...(bundled ? { installed: bundled } : {}),
				})
			} else this.inspections.set(id, { method: 'unknown', missing: true })
			return
		}
		const realPath = this.deps.realPath(program.path)
		const shimText = program.shim ? this.deps.shimText?.(program.path) : undefined
		let installed: string | undefined
		try {
			installed = await this.deps.version(program)
		} catch (error) {
			this.deps.record('engine_version_failed', { id, error })
		}
		this.inspections.set(id, {
			path: program.path,
			...(realPath ? { realPath } : {}),
			...(installed ? { installed } : {}),
			method: classifyInstall(
				id,
				{
					path: program.path,
					...(realPath ? { realPath } : {}),
					...(shimText ? { shimText } : {}),
				},
				this.deps.install,
			),
		})
	}

	private latestFor(id: EngineUpdateId): { version: string; checkedAt: number } | undefined {
		const entry = this.cache.latest[id]
		if (!entry) return undefined
		// A week-old answer is not shown as news.
		return this.deps.clock.now() - entry.checkedAt > REGISTRY_STALE_MS ? undefined : entry
	}

	private item(id: EngineUpdateId, ignoreFailure = false): EngineUpdateItem {
		const inspection = this.inspections.get(id) ?? { method: 'unknown' as const }
		const latest = this.latestFor(id)
		const operation = this.operations.get(id)
		const failure = this.failures.get(id)
		const { method } = inspection
		const command = updateCommandText(id, method)
		const runnable =
			method === 'npm-global'
				? this.deps.find('npm') !== undefined &&
					updateLaunch({
						id,
						method,
						npm: this.deps.find('npm'),
						platform: this.deps.platform,
						commandPrompt: this.deps.commandPrompt,
					}) !== undefined
				: method === 'native' || method === 'standalone'
					? inspection.path !== undefined
					: false
		let status: EngineUpdateStatus
		if (operation) status = 'updating'
		else if (failure && !ignoreFailure) status = 'failed'
		else if (inspection.bundled) status = 'current'
		else if (inspection.installed && latest)
			status = compareVersions(inspection.installed, latest.version) < 0 ? 'available' : 'current'
		else status = 'unknown'
		return {
			id,
			name: ENGINE_UPDATE_NAMES[id],
			package: ENGINE_UPDATE_PACKAGES[id],
			...(inspection.installed ? { installed: inspection.installed } : {}),
			...(latest ? { latest: latest.version, checkedAt: latest.checkedAt } : {}),
			method,
			status,
			...(inspection.missing ? { missing: true } : {}),
			...(inspection.path ? { path: inspection.path } : {}),
			...(inspection.bundled ? { bundled: true } : {}),
			...(inspection.missing || inspection.bundled ? {} : { command }),
			runnable,
			...(inspection.missing ? {} : { note: METHOD_NOTES[method] }),
			...(failure && !operation ? { error: failure } : {}),
			...(operation ? { tabId: operation.tabId } : {}),
			...(this.justUpdated.has(id) && status === 'current' ? { updated: true } : {}),
		}
	}

	private publish(): void {
		this.deps.broadcast(this.state())
	}

	/** Versions the person has not been told about yet. Each is returned once, here, whichever window asks first. */
	claimAnnouncements(): EngineUpdateAnnouncement[] {
		const found: EngineUpdateAnnouncement[] = []
		for (const id of ENGINE_UPDATE_IDS) {
			const item = this.item(id)
			if (item.status !== 'available' || !item.latest) continue
			if (this.cache.announced[id] === item.latest) continue
			this.cache.announced[id] = item.latest
			found.push({ id, name: item.name, version: item.latest })
		}
		if (found.length) this.deps.cache.write(this.cache)
		return found
	}

	/** Runs an update in a visible terminal tab. Only ever called for a click. */
	async update(id: EngineUpdateId, context: EngineUpdateContext): Promise<EngineUpdateResult> {
		if (!ENGINE_UPDATE_IDS.includes(id)) return { ok: false, reason: 'Unknown program to update.' }
		const item = this.item(id)
		const name = ENGINE_UPDATE_NAMES[id]
		if (this.operations.has(id)) return { ok: false, reason: `${name} is already being updated.` }
		if (item.status !== 'available' && item.status !== 'failed')
			return { ok: false, reason: `${name} is up to date.` }
		if (!item.runnable)
			return {
				ok: false,
				reason: `Namzu does not run this update for ${name}. Run the command yourself.`,
				...(item.command ? { command: item.command } : {}),
			}
		// One update at a time: two `npm install -g` runs would race on the same prefix.
		if (this.starting.size > 0 || this.operations.size > 0)
			return { ok: false, reason: 'Another program is being updated. Wait for it to finish.' }
		const blocked = this.deps.blocker(id)
		if (blocked) return { ok: false, reason: blocked }
		this.starting.add(id)
		try {
			return await this.launchUpdate(id, item, name, context)
		} finally {
			this.starting.delete(id)
		}
	}

	private async launchUpdate(
		id: EngineUpdateId,
		item: EngineUpdateItem,
		name: string,
		context: EngineUpdateContext,
	): Promise<EngineUpdateResult> {
		const inspection = this.inspections.get(id)
		const launch = updateLaunch({
			id,
			method: item.method,
			...(inspection?.path
				? { program: { path: inspection.path, shim: this.shim(inspection.path) } }
				: {}),
			npm: this.deps.find('npm'),
			platform: this.deps.platform,
			commandPrompt: this.deps.commandPrompt,
			...(this.deps.registry ? { registry: this.deps.registry } : {}),
		})
		if (!launch)
			return {
				ok: false,
				reason: `Namzu cannot run this update safely for ${name}. Run the command yourself.`,
				...(item.command ? { command: item.command } : {}),
			}
		try {
			await this.deps.stopServers(id)
		} catch (error) {
			// A server that would not stop is the update's own EBUSY to report.
			this.deps.record('engine_update_stop_failed', { id, error })
		}
		// A turn or an engine tab may have started while the servers were stopping.
		const later = this.deps.blocker(id)
		if (later) return { ok: false, reason: later }
		let opened: { tabId: string }
		try {
			opened = await this.deps.open(context, launch)
		} catch (error) {
			return {
				ok: false,
				reason: error instanceof Error ? error.message : String(error),
				...(item.command ? { command: item.command } : {}),
			}
		}
		this.failures.delete(id)
		this.justUpdated.delete(id)
		this.operations.set(id, {
			tabId: opened.tabId,
			...(context.windowId ? { windowId: context.windowId } : {}),
			...(inspection?.installed ? { from: inspection.installed } : {}),
		})
		this.publish()
		return { ok: true, tabId: opened.tabId }
	}

	private shim(path: string): boolean {
		return this.deps.platform === 'win32' && /\.(cmd|bat)$/iu.test(path)
	}

	/** The update's terminal ended, or its tab was closed before it did. */
	async terminalEnded(info: {
		tabId: string
		exitCode?: number
		closed?: boolean
		tail?: string
	}): Promise<void> {
		const entry = [...this.operations].find(([, operation]) => operation.tabId === info.tabId)
		if (!entry) return
		const [id, operation] = entry
		this.operations.delete(id)
		const name = ENGINE_UPDATE_NAMES[id]
		await this.inspect(id)
		const item = this.item(id, true)
		const installed = item.installed
		const succeeded = info.exitCode === 0
		if (succeeded) {
			const latest = item.latest
			const moved = installed !== undefined && installed !== operation.from
			if (installed && (moved || (latest && compareVersions(installed, latest) >= 0))) {
				this.failures.delete(id)
				this.justUpdated.add(id)
				// A fresh install may make the registry's answer stale-looking; the row now reads current.
				this.deps.updated(id)
				this.deps.notice(operation.windowId, {
					text: `${name} updated to ${installed}`,
					tone: 'success',
				})
				// Nothing is left to read in a finished, successful update: the tab closes itself.
				this.deps.finished?.(info.tabId)
			} else {
				const where = item.path ? ` (${item.path})` : ''
				this.failures.set(
					id,
					`Updated, but the installed version is still ${installed ?? 'unknown'}. Another copy may be earlier on PATH${where}.`,
				)
				this.deps.notice(operation.windowId, {
					text: `${name} update failed. The terminal tab shows why.`,
					tone: 'error',
				})
			}
		} else {
			const text =
				info.exitCode === undefined && info.closed
					? `The ${name} update was stopped before it finished.`
					: failureText(id, this.deps.platform, info.tail)
			this.failures.set(id, text)
			this.deps.notice(operation.windowId, { text, tone: 'error' })
		}
		this.publish()
	}
}
