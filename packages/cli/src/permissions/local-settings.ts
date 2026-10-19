/**
 * Where a "don't ask again" answer is written.
 *
 * The reference terminal writes an allow rule to the project's local settings
 * file, which git does not track, and keeps git
 * from tracking it by adding `**` + the file's name to the person's GLOBAL
 * git ignore (`core.excludesFile`, else `$XDG_CONFIG_HOME/git/ignore`, else
 * `~/.config/git/ignore`) the first time it writes one, when the folder is in
 * a git work tree, the file is not already ignored and not already tracked.
 * This is the Namzu side: `namzu.config.local.json` beside `namzu.config.json`,
 * read as the local layer of the config cascade, holding
 * `permissions.<tool>.<pattern> = "allow"`.
 *
 * The write merges into what is there. A file that is not valid JSON is left
 * alone and the answer holds for the session only.
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { LOCAL_CONFIG_FILE } from '../config/load.js'
import { cliLogger } from '../logging.js'
import { type PermissionsConfig, type ToolPermission, isPermissionEffect } from './rules.js'

export { LOCAL_CONFIG_FILE }

export function localConfigPath(cwd: string): string {
	return resolve(cwd, LOCAL_CONFIG_FILE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Add allows to a `permissions` table, in place of nothing it already says:
 * a tool that is already allowed as a whole needs no pattern, a pattern that
 * is already there keeps its effect, and a tool with a whole-tool `ask` or
 * `deny` is left alone because a pattern added to it would turn that into
 * something else.
 */
export function addAllowRules(
	permissions: Readonly<Record<string, unknown>>,
	additions: PermissionsConfig,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...permissions }
	for (const [tool, wanted] of Object.entries(additions)) {
		const existing = out[tool]
		if (existing === undefined) {
			out[tool] = wanted
			continue
		}
		if (isPermissionEffect(existing)) continue
		if (!isRecord(existing)) continue
		if (isPermissionEffect(wanted)) {
			// A whole-tool allow on top of a table of patterns would reorder it;
			// it is only ever asked for an MCP tool, which has no patterns.
			continue
		}
		const table: Record<string, unknown> = { ...existing }
		for (const [pattern, effect] of Object.entries(wanted as Record<string, ToolPermission>)) {
			if (table[pattern] === undefined) table[pattern] = effect
		}
		out[tool] = table
	}
	return out
}

export interface LocalWrite {
	readonly path: string
	/** Set when nothing was written; the answer then holds for this session only. */
	readonly error?: string
}

/**
 * Merge `additions` into the project's local config. Synchronous and small:
 * it runs on a keypress and must be on disk before the next turn starts.
 */
export function writeLocalAllows(cwd: string, additions: PermissionsConfig): LocalWrite {
	const path = localConfigPath(cwd)
	let document: Record<string, unknown> = {}
	if (existsSync(path)) {
		let parsed: unknown
		try {
			parsed = JSON.parse(readFileSync(path, 'utf-8'))
		} catch (cause) {
			return {
				path,
				error: `${LOCAL_CONFIG_FILE} is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
			}
		}
		if (!isRecord(parsed)) return { path, error: `${LOCAL_CONFIG_FILE} is not a JSON object` }
		document = parsed
	}
	const permissions = isRecord(document.permissions) ? document.permissions : {}
	if (document.permissions !== undefined && !isRecord(document.permissions)) {
		return { path, error: `${LOCAL_CONFIG_FILE} has a permissions value that is not a table` }
	}
	document = { ...document, permissions: addAllowRules(permissions, additions) }
	try {
		const staging = `${path}.${process.pid}.tmp`
		writeFileSync(staging, `${JSON.stringify(document, null, '\t')}\n`, { mode: 0o600 })
		renameSync(staging, path)
	} catch (cause) {
		return { path, error: cause instanceof Error ? cause.message : String(cause) }
	}
	return { path }
}

// ---------------------------------------------------------------------------
// keeping git from tracking the file
// ---------------------------------------------------------------------------

function git(
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string }> {
	return new Promise((done) => {
		execFile(
			'git',
			[...args],
			{ cwd, env, timeout: 15_000, windowsHide: true },
			(error, stdout) => {
				const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
				done({ code, stdout: String(stdout ?? '') })
			},
		)
	})
}

/** The global ignore file git reads: `core.excludesFile`, else the XDG default. */
function globalIgnorePath(configured: string, env: NodeJS.ProcessEnv): string {
	const home = env.HOME ?? env.USERPROFILE ?? homedir()
	const value = configured.trim()
	if (value === '~' || value.startsWith('~/')) return join(home, value.slice(2))
	if (value !== '' && isAbsolute(value)) return value
	const xdg = env.XDG_CONFIG_HOME
	if (xdg && isAbsolute(xdg)) return join(xdg, 'git', 'ignore')
	return join(home, '.config', 'git', 'ignore')
}

export type IgnoreOutcome =
	| { readonly state: 'ignored'; readonly written: boolean }
	| { readonly state: 'not-a-repository' }
	| { readonly state: 'tracked' | 'not-read' | 'failed'; readonly reason: string }

/**
 * Make git ignore the local config in every repository, as the reference does
 * for its own: one `**` + name line in the global ignore file, only when the
 * folder is in a git work tree and git does not ignore the file already.
 * Never throws; the answer was remembered either way.
 */
export async function ensureLocalConfigIgnored(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<IgnoreOutcome> {
	try {
		const inside = await git(['rev-parse', '--is-inside-work-tree'], cwd, env)
		if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { state: 'not-a-repository' }
		const ignored = async () =>
			(await git(['check-ignore', '--', LOCAL_CONFIG_FILE], cwd, env)).code === 0
		if (await ignored()) return { state: 'ignored', written: false }

		const configured = await git(['config', '--global', '--get', 'core.excludesfile'], cwd, env)
		const file = globalIgnorePath(configured.code === 0 ? configured.stdout : '', env)
		const line = `**/${LOCAL_CONFIG_FILE}`
		await mkdir(dirname(file), { recursive: true })
		let existing = ''
		try {
			existing = await readFile(file, 'utf-8')
		} catch {
			// Not there yet: it is created below.
		}
		const why = async (): Promise<'tracked' | 'not-read'> =>
			(await git(['ls-files', '--error-unmatch', '--', LOCAL_CONFIG_FILE], cwd, env)).code === 0
				? 'tracked'
				: 'not-read'
		if (existing.includes(line)) {
			const reason = await why()
			return { state: reason, reason: `${line} is in ${file} but git does not ignore the file` }
		}
		if (existing === '') await writeFile(file, `${line}\n`, 'utf-8')
		else await appendFile(file, `${existing.endsWith('\n') ? '' : '\n'}${line}\n`, 'utf-8')
		if (!(await ignored())) {
			const reason = await why()
			return { state: reason, reason: `wrote ${line} to ${file} but git still does not ignore it` }
		}
		return { state: 'ignored', written: true }
	} catch (cause) {
		return { state: 'failed', reason: cause instanceof Error ? cause.message : String(cause) }
	}
}

/** Say what `ensureLocalConfigIgnored` found, where it is worth saying. */
export function logIgnoreOutcome(outcome: IgnoreOutcome): void {
	if (outcome.state === 'ignored' || outcome.state === 'not-a-repository') return
	cliLogger().warn('The local config may be tracked by git', {
		'namzu.config.local.state': outcome.state,
		'namzu.config.local.reason': outcome.reason,
	})
}
