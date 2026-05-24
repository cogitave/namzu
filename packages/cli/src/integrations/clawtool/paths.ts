import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve clawtool's XDG-style config directory, honoring `XDG_CONFIG_HOME`.
 * Mirrors clawtool's Go `internal/daemon/daemon.go:75-77` behavior.
 */
export function clawtoolConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	const xdg = env.XDG_CONFIG_HOME
	if (xdg && xdg.trim().length > 0) return join(xdg, 'clawtool')
	return join(homedir(), '.config', 'clawtool')
}

export function daemonStatePath(env: NodeJS.ProcessEnv = process.env): string {
	return join(clawtoolConfigDir(env), 'daemon.json')
}

export function listenerTokenPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(clawtoolConfigDir(env), 'listener-token')
}
