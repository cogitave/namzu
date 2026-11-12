/**
 * Which Namzu processes run from an install, so that nothing replaces the install under them.
 *
 * A process loads some of its own files only when it first needs them, so replacing the folder
 * it runs from takes those files away. Each process that can run a turn (the terminal, `exec`,
 * the agent server) writes one small file, `<install's .namzu-update>/updates/running/<install>/<pid>.json`,
 * when it starts and removes it when it ends. The one that installs a newer version waits
 * until no other file names a live process. A file whose process is gone is ignored and removed,
 * so a killed process never holds an update back. It sits next to the update lock, inside the
 * install, so every Namzu home and user that can write the install sees the same files.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { UpdatesConfig } from '../../config/schema.js'
import { CLI_VERSION } from '../../version.js'
import { currentInstall } from './current-install.js'
import type { InstallKind } from './install-kind.js'
import { resolveUpdatePolicy } from './policy.js'
import { scopeOf, sharedStateHome } from './shared-state.js'
import { processIsRunning, updatesDir } from './state.js'

type Updatable = Extract<InstallKind, { kind: 'npm-global' | 'pnpm-global' }>

function runningDir(install: Updatable, platform: NodeJS.Platform): string {
	return join(updatesDir(sharedStateHome(install)), 'running', scopeOf(install, platform))
}

/**
 * Record this process as running from `install`; returns the function that removes the record.
 * Best effort: an install that cannot be written is one that cannot be updated either.
 */
export function registerRunning(
	install: Updatable,
	options: {
		readonly pid?: number
		readonly version?: string
		readonly platform?: NodeJS.Platform
	} = {},
): () => void {
	const pid = options.pid ?? process.pid
	const dir = runningDir(install, options.platform ?? process.platform)
	const file = join(dir, `${pid}.json`)
	try {
		mkdirSync(dir, { recursive: true })
		writeFileSync(file, `${JSON.stringify({ pid, version: options.version ?? CLI_VERSION })}\n`)
	} catch {
		return () => undefined
	}
	return () => {
		try {
			rmSync(file, { force: true })
		} catch {
			// A leftover file names a dead process and is ignored.
		}
	}
}

/** The process ids, other than `except`, that are running from `install`. Dead ones are removed. */
export function otherRunning(
	install: Updatable,
	options: {
		readonly except?: number
		readonly isAlive?: (pid: number) => boolean
		readonly platform?: NodeJS.Platform
	} = {},
): number[] {
	const dir = runningDir(install, options.platform ?? process.platform)
	const alive = options.isAlive ?? processIsRunning
	const found: number[] = []
	let names: string[]
	try {
		names = readdirSync(dir)
	} catch {
		return found
	}
	for (const name of names) {
		const match = /^(\d+)\.json$/.exec(name)
		if (!match) continue
		const pid = Number(match[1])
		if (pid === options.except) continue
		if (alive(pid)) {
			found.push(pid)
			continue
		}
		try {
			rmSync(join(dir, name), { force: true })
		} catch {
			// Not removing a stale file costs one more check.
		}
	}
	return found
}

/**
 * Register this process when it runs from an install that an update replaces in place.
 * A copy that is never updated (a checkout, the Desktop app's engine, `npx`) writes nothing,
 * and neither does a process with updates switched off: nothing is added to the package
 * manager's folder for a person who turned them off.
 */
export function registerRunningSession(
	env: NodeJS.ProcessEnv = process.env,
	updates?: UpdatesConfig,
	find: typeof currentInstall = currentInstall,
): () => void {
	try {
		if (!resolveUpdatePolicy({ config: updates, env, interactive: true }).check) {
			return () => undefined
		}
		const found = find(env)
		if (!found) return () => undefined
		const { install } = found
		if ((install.kind !== 'npm-global' && install.kind !== 'pnpm-global') || !install.writable) {
			return () => undefined
		}
		const stop = registerRunning(install)
		process.once('exit', stop)
		// Records of windows that were killed (a closed terminal, a crash) are removed as the next one starts.
		otherRunning(install, { except: process.pid })
		return stop
	} catch {
		return () => undefined
	}
}

/** For tests and the readers of the file: the version a record names. */
export function readRunningVersion(file: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
		return typeof parsed.version === 'string' ? parsed.version : undefined
	} catch {
		return undefined
	}
}
