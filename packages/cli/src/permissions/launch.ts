import { existsSync } from 'node:fs'

import {
	type PermissionMode,
	bypassAvailable,
	permissionModeFromName,
	unknownPermissionModeMessage,
} from './mode.js'
import type { PermissionSettings } from './settings.js'

/**
 * How a launch settles its permission mode, and what it may not start in.
 *
 * One function for every entry point (the terminal, `exec`, `exec --json`, a
 * resident step) so the answer to "may this process run without asking?" is
 * the same wherever the question is put.
 */

export interface LaunchEnvironment {
	/** Whether the process runs as the superuser. */
	readonly root: boolean
	/** Whether it runs inside a container or a sandbox that already bounds it. */
	readonly sandboxed: boolean
}

/** Whether a container or sandbox already bounds this process. */
export function detectSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.IS_SANDBOX === '1' || env.NAMZU_SANDBOX === '1') return true
	return existsSync('/.dockerenv') || existsSync('/run/.containerenv')
}

export function detectLaunchEnvironment(env: NodeJS.ProcessEnv = process.env): LaunchEnvironment {
	return {
		root: typeof process.getuid === 'function' && process.getuid() === 0,
		sandboxed: detectSandbox(env),
	}
}

/**
 * Why a process may not start in `mode`, in words for the person who typed the
 * flag, or undefined when it may.
 *
 * Bypass is refused as the superuser outside a sandbox: with no account
 * boundary and no container, "run everything" is the whole machine. This is a
 * decision about the process, not about a rule, so no setting lifts it.
 */
export function launchRefusal(
	mode: PermissionMode,
	options: {
		readonly settings?: PermissionSettings | undefined
		readonly environment?: LaunchEnvironment | undefined
	} = {},
): string | undefined {
	if (mode === 'bypass') {
		if (options.settings?.disableBypassMode === true) {
			return 'Bypass mode is turned off by permissions.disableBypassMode in your configuration.'
		}
		const environment = options.environment ?? detectLaunchEnvironment()
		if (environment.root && !environment.sandboxed) {
			return 'Bypass mode cannot be used as the root user outside a sandbox. Run Namzu as a regular user, or inside a container or sandbox.'
		}
	}
	if (mode === 'classify' && options.settings?.disableAutoMode === true) {
		return 'Auto mode is turned off by permissions.disableAutoMode in your configuration.'
	}
	return undefined
}

export interface LaunchPlan {
	/** The mode the session starts in. */
	readonly mode: PermissionMode
	/** Why: the flag, the bypass alias, the configured default, or nothing. */
	readonly source: 'launch-flag' | 'launch-bypass' | 'config-default' | 'default'
	/** Whether Shift+Tab and `/permissions` may reach bypass in this session. */
	readonly bypassAvailable: boolean
}

/**
 * The terminal's starting mode from the command line and the configuration.
 *
 * A `--permission-mode` names the mode outright and wins over the aliases. The
 * aliases (`--yolo`, `--dangerously-skip-permissions`) mean bypass. With
 * neither, the configured `permissions.defaultMode` applies, and a default that
 * the settings switched off falls back to `prompt` rather than refusing to
 * start: nobody typed it on this launch.
 */
export function planLaunchMode(opts: {
	readonly permissionModeFlag?: string | undefined
	readonly skipPermissions?: boolean | undefined
	readonly allowBypassFlag?: boolean | undefined
	readonly settings?: PermissionSettings | undefined
	readonly environment?: LaunchEnvironment | undefined
}): { readonly plan: LaunchPlan } | { readonly error: string } {
	const settings = opts.settings
	let mode: PermissionMode | undefined
	let source: LaunchPlan['source'] = 'default'
	if (opts.permissionModeFlag != null && opts.permissionModeFlag !== '') {
		mode = permissionModeFromName(opts.permissionModeFlag)
		if (mode === undefined) return { error: unknownPermissionModeMessage(opts.permissionModeFlag) }
		source = 'launch-flag'
	} else if (opts.skipPermissions === true) {
		mode = 'bypass'
		source = 'launch-bypass'
	} else if (settings?.defaultMode !== undefined) {
		const configured = permissionModeFromName(settings.defaultMode)
		if (configured !== undefined && launchRefusal(configured, opts) === undefined) {
			mode = configured
			source = 'config-default'
		}
	}
	const chosen = mode ?? 'prompt'
	// A mode a person typed is refused plainly; one the configuration chose was
	// already screened above.
	if (source === 'launch-flag' || source === 'launch-bypass') {
		const refusal = launchRefusal(chosen, opts)
		if (refusal) return { error: refusal }
	}
	const flagged =
		opts.skipPermissions === true ||
		opts.allowBypassFlag === true ||
		opts.permissionModeFlag === 'bypass'
	return {
		plan: {
			mode: chosen,
			source,
			// `--allow-dangerously-skip-permissions` only makes bypass reachable; a
			// process that may not enter it (the root guard) does not get the stop.
			bypassAvailable:
				bypassAvailable({
					flagged,
					defaultMode: settings?.defaultMode,
					disabled: settings?.disableBypassMode,
				}) && launchRefusal('bypass', opts) === undefined,
		},
	}
}
