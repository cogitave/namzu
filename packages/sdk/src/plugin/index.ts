export { discoverPlugins, loadPluginManifest, discoverAllPluginDirs } from './loader.js'
export type { PluginDiscoveryOptions, PluginEnablementCapabilities } from './loader.js'
export { PluginLifecycleManager } from './lifecycle.js'
export { PluginResolver } from './resolver.js'
export {
	attachShellHooks,
	createShellHook,
	DEFAULT_SHELL_HOOK_TIMEOUT_MS,
	MAX_SHELL_HOOK_TIMEOUT_MS,
	runShellHook,
	SHELL_HOOK_EVENTS,
	SHELL_HOOKS_PLUGIN_ID,
	shellHookMatches,
	shellHookVerdict,
} from './shell-hook.js'
export type {
	ShellHookEntry,
	ShellHookEvent,
	ShellHookInput,
	ShellHookOptions,
	ShellHookOutcome,
	ShellHooksConfig,
} from './shell-hook.js'
