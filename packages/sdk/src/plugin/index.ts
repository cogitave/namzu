export { discoverPlugins, loadPluginManifest, discoverAllPluginDirs } from './loader.js'
export { definePlugin } from './define.js'
export type { DefinedPlugin, DefinePluginOptions } from './define.js'
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
	shellHookIfMatches,
	shellHookMatches,
	shellHookVerdict,
} from './shell-hook.js'
export type {
	HttpHookEntry,
	PromptHookEntry,
	ShellHookEntry,
	ShellHookEvent,
	ShellHookHandler,
	ShellHookJudge,
	ShellHookOnFailure,
	ShellHookInput,
	ShellHookOptions,
	ShellHookOutcome,
	ShellHooksConfig,
} from './shell-hook.js'
