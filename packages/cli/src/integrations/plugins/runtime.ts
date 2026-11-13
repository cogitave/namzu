import {
	type PluginHookDefinition,
	PluginLifecycleManager,
	PluginRegistry,
	SHELL_HOOKS_PLUGIN_ID,
	SHELL_HOOK_EVENTS,
	type ShellHookOptions,
	SkillRegistry,
	attachShellHooks,
	createShellHook,
	discoverAllPluginDirs,
} from '@namzu/sdk'

import type { HooksSwitch } from '../../config/hook-layers.js'
import type { HookEntry, HooksConfig, PluginConfig, PluginScope } from '../../config/schema.js'
import { cliLogger } from '../../logging.js'
import { resolveNamzuHome } from '../state/home.js'
import { listMarkdownNames, resolvePluginFileDirs } from './files.js'
import { type SessionHookActivity, createSessionHookActivity } from './hook-activity.js'
import {
	type PluginHookProblem,
	dataDirOverlapsPlugin,
	pluginDataDir,
	readPluginHookEntriesOf,
} from './hook-entries.js'
import { createHookPathFilter } from './hook-path-filter.js'
import { PluginSettingsStore } from './settings.js'

/**
 * How long a `session_end` hook may run when its entry sets no `timeoutMs`.
 * Closing a session waits for these hooks, so one that hangs would hold
 * `/exit` and the end of `namzu exec` for the ordinary ten minutes.
 */
export const SESSION_END_HOOK_TIMEOUT_MS = 5_000

/** The most a hook entry may run: the SDK's own cap on any hook deadline. */
const MAX_HOOK_TIMEOUT_MS = 10 * 60_000

/**
 * The longest a session close can spend in `session_end` hooks: the largest
 * deadline among the entries that are waited for (an `async` one is not), five
 * seconds for an entry that names none. Zero when there are none. A host that
 * stops waiting for the close must wait at least this long beyond its own
 * allowance for the rest of the close, or it leaves before the hook's deadline
 * can end the hook's process.
 */
export function sessionEndHookBudgetMs(hooks: HooksConfig | undefined): number {
	let longest = 0
	for (const entry of hooks?.session_end ?? []) {
		if ('async' in entry && entry.async === true) continue
		const own = entry.timeoutMs ?? SESSION_END_HOOK_TIMEOUT_MS
		longest = Math.max(longest, Math.min(MAX_HOOK_TIMEOUT_MS, Math.max(1, own)))
	}
	return longest
}

/** The one plain line that says a hook was ended at its deadline. */
export function hookTimeoutLine(info: {
	readonly event: string
	readonly hook: string
	readonly timeoutMs: number
}): string {
	const seconds = info.timeoutMs / 1000
	return `The ${info.event} hook \`${info.hook}\` did not finish within ${seconds} second${seconds === 1 ? '' : 's'} and was ended.`
}

/** One hook entry a plugin ships, as `/hooks` lists it. */
export interface PluginHookEntryView {
	/** The plugin's name. */
	readonly plugin: string
	readonly event: string
	readonly entry: HookEntry
	/** Set when a switch left it off; it is listed and does not run. */
	readonly off?: HooksSwitch
}

export interface CliPluginRuntime {
	readonly manager: PluginLifecycleManager
	/** What every shell hook of this session is run with; a skill's hooks use the same. */
	readonly hookOptions: ShellHookOptions
	readonly skills: SkillRegistry
	readonly pluginCount: number
	/** How long closing the session may spend in `session_end` hooks; see {@link sessionEndHookBudgetMs}. */
	readonly sessionEndBudgetMs: number
	/**
	 * What hooks do beside answering: the variables they set for later commands,
	 * the files they watch and the lines they gave for the person.
	 */
	readonly hookActivity: SessionHookActivity
	list(): readonly CliPluginInfo[]
	/** The JavaScript hooks plugins registered right now: the plugin's name and the event. */
	pluginHooks(): readonly { readonly plugin: string; readonly event: string }[]
	/** The hook entries (commands, addresses, prompts) enabled plugins ship, apart from their JavaScript hooks. */
	pluginHookEntries(): readonly PluginHookEntryView[]
	/** What could not be loaded from the hook entries plugins ship, with the plugin's name. */
	pluginHookProblems(): readonly (PluginHookProblem & { readonly plugin: string })[]
	/** The lines the launch says once about those problems; each call returns what is new. */
	takePluginHookWarnings(): string[]
	setEnabled(name: string, enabled: boolean): Promise<void>
	rememberState(name: string): Promise<void>
	close(): Promise<void>
}

/** Public operator metadata only; never expose MCP environment or hook bodies. */
export interface CliPluginInfo {
	readonly name: string
	readonly version: string
	readonly description: string
	readonly scope: PluginScope
	readonly rootDir: string
	readonly status: string
	readonly startupEnabled?: boolean
	readonly startupError?: string
	readonly tools: readonly string[]
	readonly skills: readonly string[]
	readonly hookModules: readonly string[]
	/** How many shell, http or prompt hook entries the plugin ships, enabled or not. */
	readonly hookEntries?: number
	readonly mcpServers: readonly string[]
	/** Slash commands from the plugin's command folders, as typed (`<plugin>__<file>`). */
	readonly commands: readonly string[]
	/** Agent files from the plugin's agent folders, as named to the model. */
	readonly agents: readonly string[]
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * Build the executable extension runtime owned by one agent session.
 *
 * The exact `enabled === true` check is the default-off boundary. Nothing in
 * the plugin directories is discovered, read, or imported on every other
 * value. Callers invoke this only after project trust has pinned `cwd`.
 *
 * No longer takes a tool registry to register into (plan.md v3 §7):
 * `PluginLifecycleManager` exposes one live file source per plugin and one
 * live MCP source per plugin server (`manager.toolsets`); a caller folds them into
 * its own `toolsets` array. The `skill` tool itself is the CALLER's concern
 * now too — this runtime only reports `skills.size` so the caller can decide
 * live whether to offer it, rather than this module owning a "who registered
 * it first" flag over a shared mutable registry.
 */
export async function createCliPluginRuntime(
	config: PluginConfig | undefined,
	cwd: string,
	/**
	 * Operator shell hooks. They ride the same lifecycle manager plugins use,
	 * so a session with hooks and no plugins still builds one — with nothing
	 * installed, and `pluginCount` honestly 0.
	 */
	hooks?: HooksConfig,
	/** What a hook's stdin says about the session; each is read at every hook run. */
	hookHost?: Pick<ShellHookOptions, 'transcriptPath' | 'permissionMode' | 'judge'> & {
		/** The session now, for the hooks the host fires itself (`file_changed`, `cwd_changed`). */
		readonly sessionId?: () => string
	},
	/**
	 * What the host knows beyond the hook entries themselves.
	 *
	 * `keepForSkills`: a skill of this session carries hooks, which attach to
	 * the lifecycle manager when it is used, so the manager is built even when
	 * there are no plugins and no configured hooks.
	 *
	 * `hooksSwitch` is the switch limiting hooks to the organisation-managed file
	 * (`hooksManagedOnly`) or turning them off (`disableHooks`, `NAMZU_DISABLE_HOOKS`).
	 * Hook entries a plugin ships obey it: no plugin comes from the managed file,
	 * so under either they are read and listed but not attached. It is the same
	 * value the host hands the code that attaches a skill's and an agent file's
	 * hooks.
	 */
	host?: { readonly keepForSkills?: boolean; readonly hooksSwitch?: HooksSwitch },
): Promise<CliPluginRuntime | undefined> {
	const pluginsEnabled = config?.enabled === true
	const launchDirs = config?.launchDirs ?? []
	const hookCount = hooks ? Object.values(hooks).reduce((n, list) => n + (list?.length ?? 0), 0) : 0
	if (
		!pluginsEnabled &&
		hookCount === 0 &&
		launchDirs.length === 0 &&
		host?.keepForSkills !== true
	) {
		return undefined
	}

	const log = cliLogger()
	const userRoot = resolveNamzuHome()
	const settings = new PluginSettingsStore(userRoot)
	const plugins = new PluginRegistry()
	const skills = new SkillRegistry(log)
	const { sessionId: currentSession, ...shellHost } = hookHost ?? {}
	const hookActivity = createSessionHookActivity({
		hooks,
		cwd,
		sessionId: currentSession ?? (() => ''),
	})
	const shellOptions: ShellHookOptions = {
		hookEnv: hookActivity.hookEnv,
		cwd,
		// The folder the session was started for, for a hook script to find its own files.
		projectDir: cwd,
		pathFilter: createHookPathFilter(cwd),
		log,
		defaultTimeoutMs: { session_end: SESSION_END_HOOK_TIMEOUT_MS },
		// Only the close of a session says so out loud: it is the one place
		// a person is left waiting with nothing on screen to explain it.
		onTimeout: (info) => {
			if (info.event === 'session_end') process.stderr.write(`${hookTimeoutLine(info)}\n`)
		},
		...shellHost,
	}
	// The hook entries each enabled plugin ships, read when it is enabled and
	// attached under the plugin's id, so disabling the plugin removes them.
	const shipped = new Map<
		string,
		{
			readonly name: string
			readonly entries: readonly { readonly event: string; readonly entry: HookEntry }[]
			readonly problems: readonly PluginHookProblem[]
			readonly off?: HooksSwitch
		}
	>()
	const warningLines: string[] = []
	const hooksSwitch = host?.hooksSwitch
	const manager = new PluginLifecycleManager({
		pluginRegistry: plugins,
		skillRegistry: skills,
		scopeRoots: { project: cwd, user: userRoot },
		log,
		...(config?.hookTimeoutMs !== undefined ? { hookTimeoutMs: config.hookTimeoutMs } : {}),
		hooksFor: (plugin): readonly PluginHookDefinition[] => {
			const read = readPluginHookEntriesOf(plugin)
			const name = plugin.manifest.name
			const dataDir = pluginDataDir(userRoot, {
				name,
				scope: plugin.scope,
				rootDir: plugin.rootDir,
			})
			const problems = [...read.problems]
			let usable = true
			if (read.count > 0 && dataDirOverlapsPlugin(dataDir, plugin.rootDir)) {
				usable = false
				problems.push({
					severity: 'problem',
					code: 'hook-entries-invalid',
					file: name,
					message: `its data folder ${dataDir} would overlap the plugin's own folder, so its hook entries are not attached.`,
				})
			}
			const entries = SHELL_HOOK_EVENTS.flatMap((event) =>
				(read.hooks[event] ?? []).map((entry) => ({ event: event as string, entry })),
			)
			shipped.set(plugin.id, {
				name,
				entries,
				problems,
				...(hooksSwitch !== undefined ? { off: hooksSwitch } : {}),
			})
			for (const problem of problems) {
				warningLines.push(
					`${problem.severity === 'problem' ? 'Hook problem' : 'Hook note'} in plugin ${name}, ${problem.file}: ${problem.message}`,
				)
			}
			// A switch someone set is honoured: the entries are read and listed, and none runs.
			if (hooksSwitch !== undefined || !usable) return []
			const options: ShellHookOptions = {
				...shellOptions,
				plugin: { root: plugin.rootDir, dataDir },
			}
			return entries.map(({ event, entry }) =>
				createShellHook(event as (typeof SHELL_HOOK_EVENTS)[number], entry, options),
			)
		},
	})
	// The watcher and the variables file need the manager; the manager's hooks need the file.
	hookActivity.attach(manager)
	if (hooks && hookCount > 0) attachShellHooks(manager, hooks, shellOptions)
	const allowedScopes = config?.allowedScopes ?? (['project', 'user'] as const)
	const discovered = pluginsEnabled
		? await discoverAllPluginDirs(cwd, {
				enabled: true,
				autoDiscovery: config?.autoDiscovery ?? true,
				allowedScopes,
				userRoot,
				log,
			})
		: { project: [], user: [] }
	const installed: Awaited<ReturnType<PluginLifecycleManager['install']>>[] = []

	try {
		for (const scope of allowedScopes) {
			const dirs = [...discovered[scope]].sort((a, b) => a.localeCompare(b))
			for (const dir of dirs) {
				const plugin = await manager.install(dir, scope as PluginScope)
				installed.push(plugin)
				const enabled = settings.read({ rootDir: plugin.rootDir, name: plugin.manifest.name })
				if (enabled) await manager.enable(plugin.id)
			}
		}
		// Folders named on the command line: each is its own authority, loaded
		// without `plugins.enabled`, and a plugin already found above keeps its
		// place.
		for (const dir of launchDirs) {
			const plugin = await manager.install(dir, 'user', { authorityRoot: dir })
			installed.push(plugin)
			const enabled = settings.read({ rootDir: plugin.rootDir, name: plugin.manifest.name })
			if (enabled) await manager.enable(plugin.id)
		}
	} catch (error) {
		const cleanupErrors: unknown[] = []
		for (const plugin of [...installed].reverse()) {
			try {
				await manager.uninstall(plugin.id)
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError)
			}
		}
		const cleanupSuffix =
			cleanupErrors.length === 0
				? ''
				: ` Cleanup also failed: ${cleanupErrors.map(message).join('; ')}`
		throw new Error(`Plugin runtime could not start: ${message(error)}.${cleanupSuffix}`, {
			cause: error,
		})
	}

	let closePromise: Promise<void> | undefined
	let closed = false
	let mutation: Promise<void> | undefined
	const contributedToolNames = (prefix: string): string[] =>
		manager.toolsets
			.flatMap((ts) => ts.tools())
			.map((tool) => tool.name)
			.filter((name) => name.startsWith(prefix))
			.sort()
	return {
		manager,
		hookOptions: shellOptions,
		skills,
		pluginCount: installed.length,
		sessionEndBudgetMs: sessionEndHookBudgetMs(hooks),
		hookActivity,
		pluginHookEntries: () =>
			plugins
				.getAll()
				.filter((plugin) => plugin.status === 'enabled')
				.flatMap((plugin) => {
					const state = shipped.get(plugin.id)
					return (state?.entries ?? []).map(({ event, entry }) => ({
						plugin: state?.name ?? plugin.manifest.name,
						event,
						entry,
						...(state?.off !== undefined ? { off: state.off } : {}),
					}))
				}),
		pluginHookProblems: () =>
			plugins
				.getAll()
				.filter((plugin) => plugin.status === 'enabled')
				.flatMap((plugin) =>
					(shipped.get(plugin.id)?.problems ?? []).map((problem) => ({
						...problem,
						plugin: plugin.manifest.name,
					})),
				),
		takePluginHookWarnings: () => warningLines.splice(0),
		pluginHooks: () =>
			manager
				.listHooks()
				.filter((hook) => hook.pluginId !== SHELL_HOOKS_PLUGIN_ID && hook.shell !== true)
				.map((hook) => ({
					plugin: plugins.get(hook.pluginId)?.manifest.name ?? String(hook.pluginId),
					event: hook.event,
				})),
		list: () =>
			plugins
				.getAll()
				.map((plugin) => {
					const prefix = `${plugin.manifest.name}__`
					let startupEnabled: boolean | undefined
					let startupError: string | undefined
					try {
						startupEnabled = settings.read({ rootDir: plugin.rootDir, name: plugin.manifest.name })
					} catch (error) {
						startupError = message(error)
					}
					return {
						name: plugin.manifest.name,
						version: plugin.manifest.version,
						description: plugin.manifest.description,
						scope: plugin.scope,
						rootDir: plugin.rootDir,
						status: plugin.status === 'installed' ? 'disabled' : plugin.status,
						...(startupEnabled !== undefined ? { startupEnabled } : {}),
						...(startupError ? { startupError } : {}),
						tools: contributedToolNames(prefix),
						skills: skills
							.list()
							.map((skill) => skill.metadata.name)
							.filter((name) => name.startsWith(prefix))
							.sort(),
						hookModules: (plugin.manifest.hooks ?? []).filter(
							(path) => !path.toLowerCase().endsWith('.json'),
						),
						hookEntries: readPluginHookEntriesOf(plugin).count,
						mcpServers: (plugin.manifest.mcpServers ?? []).map((server) => server.name),
						commands: resolvePluginFileDirs(
							plugin.manifest.name,
							plugin.rootDir,
							plugin.manifest.commands,
						).dirs.flatMap((source) =>
							listMarkdownNames(source.dir).map((file) => `${prefix}${file}`),
						),
						agents: resolvePluginFileDirs(
							plugin.manifest.name,
							plugin.rootDir,
							plugin.manifest.agents,
						).dirs.flatMap((source) =>
							listMarkdownNames(source.dir).map((file) => `${prefix}${file}`),
						),
					}
				})
				.sort((a, b) => a.name.localeCompare(b.name)),
		async setEnabled(name, enabled) {
			if (closed) throw new Error('Plugin runtime is closed.')
			if (mutation) throw new Error('Another plugin change is in progress.')
			const plugin = plugins.findByName(name)
			if (!plugin) throw new Error(`Plugin "${name}" is not loaded in this session.`)
			if (
				(enabled && plugin.status === 'enabled') ||
				(!enabled && (plugin.status === 'disabled' || plugin.status === 'installed'))
			)
				return
			mutation = enabled ? manager.enable(plugin.id) : manager.disable(plugin.id)
			try {
				await mutation
			} finally {
				mutation = undefined
			}
		},
		async rememberState(name) {
			if (closed) throw new Error('Plugin runtime is closed.')
			if (mutation) throw new Error('Another plugin change is in progress.')
			const plugin = plugins.findByName(name)
			if (!plugin) throw new Error(`Plugin "${name}" is not loaded in this session.`)
			if (!['enabled', 'disabled', 'installed'].includes(plugin.status)) {
				throw new Error('Resolve the plugin error before remembering its state.')
			}
			const enabled = plugin.status === 'enabled'
			settings.write({ rootDir: plugin.rootDir, name }, enabled)
		},
		close() {
			if (closePromise) return closePromise
			closed = true
			closePromise = (async () => {
				hookActivity.close()
				if (mutation) await mutation.catch(() => {})
				const errors: unknown[] = []
				for (const plugin of [...installed].reverse()) {
					try {
						await manager.uninstall(plugin.id)
					} catch (error) {
						errors.push(error)
					}
				}
				if (errors.length > 0) {
					throw new AggregateError(errors, 'One or more plugins could not be uninstalled.')
				}
			})()
			return closePromise
		},
	}
}
