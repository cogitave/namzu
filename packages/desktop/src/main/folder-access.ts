import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { basename } from 'node:path'
import type { BroadFolderKind, ProjectView } from '../shared/protocol.js'
import { findAutoRunSettings } from './folder-settings.js'

/**
 * Who consents to a folder, and when.
 *
 * - A folder chosen in the app's own native folder picker is trusted by the main
 *   process right after the pick. The pick is the consent and main captured it,
 *   never the renderer.
 * - A broad folder (a drive root, the home folder itself, a system folder) is
 *   never trusted by the pick. Main answers with a one-time token bound to that
 *   exact canonical path and window; only a redeemed token trusts it.
 * - A picked folder that carries settings able to run code on their own (hooks, servers,
 *   plugins…) is not added by the pick. Main answers with a pending folder and a one-time
 *   token; the folder joins the app, trusted, only when that token is redeemed. Cancelling
 *   adds nothing.
 * - A folder main created itself (a new project) is trusted at once: creating it is the consent.
 * - A folder that is already known but untrusted (restored, opened by path,
 *   created by the CLI) is trusted when the person confirms the in-app dialog.
 *   That consent is captured by the renderer: the person already added the
 *   folder, and the dialog states what access means.
 */

export const FOLDER_ACCESS_TOKEN_TTL_MS = 5 * 60_000

export interface BroadFolderEnv {
	platform: NodeJS.Platform
	home: string
	/** Variable lookups such as WINDIR; absent values are skipped. */
	env: Record<string, string | undefined>
}

interface BroadRule {
	kind: BroadFolderKind
	/** Paths this rule names, resolved from the environment. */
	paths: (input: BroadFolderEnv) => Array<string | undefined>
	/** True when everything beneath a path is covered too, not only the path itself. */
	within: boolean
	platforms?: NodeJS.Platform[]
}

/** The list is data: add a row, not a branch. */
export const BROAD_FOLDER_RULES: readonly BroadRule[] = [
	{ kind: 'home', paths: (input) => [input.home], within: false },
	{
		kind: 'system',
		platforms: ['win32'],
		within: true,
		paths: ({ env }) => [
			env.WINDIR ?? env.SystemRoot,
			env.ProgramFiles,
			env['ProgramFiles(x86)'],
			env.ProgramW6432,
			env.ProgramData,
		],
	},
	{
		kind: 'system',
		platforms: ['win32'],
		within: false,
		paths: ({ env }) => [
			env.APPDATA,
			env.LOCALAPPDATA,
			env.SystemDrive ? `${env.SystemDrive}\\Users` : undefined,
		],
	},
	{
		kind: 'system',
		platforms: ['linux', 'darwin'],
		within: true,
		paths: () => [
			'/etc',
			'/usr',
			'/bin',
			'/sbin',
			'/lib',
			'/lib64',
			'/boot',
			'/dev',
			'/proc',
			'/sys',
		],
	},
	{
		kind: 'system',
		platforms: ['linux', 'darwin'],
		within: false,
		paths: () => ['/var', '/opt', '/root', '/home', '/mnt', '/Users', '/Volumes'],
	},
	{
		kind: 'system',
		platforms: ['darwin'],
		within: true,
		paths: () => ['/System', '/Library', '/Applications'],
	},
]

function same(left: string, right: string, windows: boolean): boolean {
	return windows ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Classifies an already canonical absolute path; undefined means an ordinary folder. */
export function classifyBroadFolder(
	path: string,
	input: BroadFolderEnv,
	/** Resolves links and short names in the listed folders, so they compare like the picked path. */
	canonical: (path: string) => string = (value) => value,
): BroadFolderKind | undefined {
	const windows = input.platform === 'win32'
	const lib = windows ? win32 : posix
	const normal = lib.normalize(path)
	if (normal === lib.parse(normal).root) return 'drive'
	// A Windows drive as WSL mounts it (/mnt/c) is a drive root, not a folder.
	if (!windows && /^\/mnt\/[a-zA-Z]\/*$/.test(normal)) return 'drive'
	const target = normal.replace(/[\\/]+$/, '')
	for (const rule of BROAD_FOLDER_RULES) {
		if (rule.platforms && !rule.platforms.includes(input.platform)) continue
		for (const candidate of rule.paths(input)) {
			if (!candidate) continue
			const base = lib.normalize(canonical(candidate)).replace(/[\\/]+$/, '')
			if (!base) continue
			if (same(target, base, windows)) return rule.kind
			if (rule.within) {
				const relative = lib.relative(base, target)
				const inside = relative !== '' && !relative.startsWith('..') && !lib.isAbsolute(relative)
				const sameDrive =
					!windows || target.slice(0, 2).toLowerCase() === base.slice(0, 2).toLowerCase()
				if (inside && sameDrive) return rule.kind
			}
		}
	}
	return undefined
}

interface Grant {
	windowId: string
	path: string
	expires: number
}

/** One-time grants for broad folders. A token is spent by the first attempt to use it. */
export class FolderAccessTokens {
	private readonly grants = new Map<string, Grant>()
	constructor(
		private readonly now: () => number = Date.now,
		private readonly random: () => string = () => randomBytes(24).toString('hex'),
		private readonly ttlMs = FOLDER_ACCESS_TOKEN_TTL_MS,
		private readonly sameFolder: (a: string, b: string) => boolean = (a, b) => a === b,
	) {}

	issue(windowId: string, path: string): string {
		for (const [token, grant] of this.grants)
			if (grant.expires <= this.now()) this.grants.delete(token)
		// One live token per window and folder: asking again replaces the earlier one.
		for (const [token, grant] of this.grants)
			if (grant.windowId === windowId && this.sameFolder(grant.path, path))
				this.grants.delete(token)
		const token = this.random()
		this.grants.set(token, { windowId, path, expires: this.now() + this.ttlMs })
		return token
	}

	/** Spends a token issued to this window and returns the path it named, or undefined. */
	take(token: unknown, windowId: string): string | undefined {
		if (typeof token !== 'string') return undefined
		const grant = this.grants.get(token)
		if (!grant) return undefined
		this.grants.delete(token)
		return grant.expires > this.now() && grant.windowId === windowId ? grant.path : undefined
	}

	/** True only for an unspent, unexpired token issued to this window for this exact path. */
	redeem(token: unknown, windowId: string, path: string): boolean {
		if (typeof token !== 'string') return false
		const grant = this.grants.get(token)
		if (!grant) return false
		this.grants.delete(token)
		return (
			grant.expires > this.now() && grant.windowId === windowId && this.sameFolder(grant.path, path)
		)
	}
}

export interface FolderAccessDeps {
	openProject(path: string): Promise<ProjectView>
	findProject(id: string): ProjectView | undefined
	trust(id: string): Promise<ProjectView>
	canonical?: (path: string) => string
	env?: BroadFolderEnv
	tokens?: FolderAccessTokens
	/** Names of auto-run settings in a folder; empty for an ordinary one. */
	findSettings?: (path: string) => Promise<string[]>
}

/** The id a folder that is not in the app yet carries; no project ever has it. */
export const PENDING_FOLDER_ID = 'pending-folder'

export function canonicalFolder(path: string): string {
	try {
		return realpathSync.native(path)
	} catch {
		return path
	}
}

export class FolderAccess {
	private readonly canonical: (path: string) => string
	private readonly env: BroadFolderEnv
	private readonly tokens: FolderAccessTokens
	private readonly findSettings: (path: string) => Promise<string[]>
	constructor(private readonly deps: FolderAccessDeps) {
		this.canonical = deps.canonical ?? canonicalFolder
		this.findSettings = deps.findSettings ?? findAutoRunSettings
		this.env = deps.env ?? { platform: process.platform, home: homedir(), env: process.env }
		const windows = this.env.platform === 'win32'
		this.tokens =
			deps.tokens ??
			new FolderAccessTokens(undefined, undefined, undefined, (a, b) => same(a, b, windows))
	}

	/** The person chose this folder in the native picker. */
	async picked(windowId: string, path: string): Promise<ProjectView> {
		const canonical = this.canonical(path)
		if (!classifyBroadFolder(canonical, this.env, this.canonical)) {
			const found = await this.findSettings(canonical)
			if (found.length > 0)
				return {
					id: PENDING_FOLDER_ID,
					path,
					name: basename(path) || path,
					trusted: false,
					status: 'ready',
					pending: true,
					riskySettings: { found, token: this.tokens.issue(windowId, canonical) },
				}
		}
		const project = await this.deps.openProject(path)
		if (project.trusted || project.status !== 'ready') return project
		return this.decide(windowId, project)
	}

	/** The person confirmed the trust dialog for a pending folder: add it, trusted. */
	async admit(windowId: string, token: unknown): Promise<ProjectView> {
		const path = this.tokens.take(token, windowId)
		if (!path) throw new Error('This folder confirmation expired. Choose the folder again.')
		const project = await this.deps.openProject(path)
		if (project.trusted) return project
		return this.deps.trust(project.id)
	}

	/** Main made this folder itself, so creating it is the consent. */
	async created(path: string): Promise<ProjectView> {
		const project = await this.deps.openProject(path)
		if (project.trusted) return project
		return this.deps.trust(project.id)
	}

	/**
	 * The person confirmed the in-app dialog for a known folder. Without a token this is
	 * renderer-captured consent, accepted for ordinary folders only.
	 */
	async confirm(windowId: string, id: string, token?: unknown): Promise<ProjectView> {
		const project = this.deps.findProject(id)
		if (!project) throw new Error('Unknown project.')
		if (project.trusted || project.status !== 'ready') return project
		if (token === undefined) return this.decide(windowId, project)
		if (!this.tokens.redeem(token, windowId, this.canonical(project.path)))
			throw new Error('This folder confirmation expired. Choose the folder again.')
		return this.deps.trust(id)
	}

	private async decide(windowId: string, project: ProjectView): Promise<ProjectView> {
		const path = this.canonical(project.path)
		const kind = classifyBroadFolder(path, this.env, this.canonical)
		if (kind) return { ...project, broadFolder: { kind, token: this.tokens.issue(windowId, path) } }
		const found = await this.findSettings(path)
		// A folder whose settings changed is never trusted on the renderer's word: it gets the
		// detailed dialog, with what changed first, and trust takes main's token.
		if (project.settingsChanged?.length)
			return {
				...project,
				riskySettings: {
					found: [
						...project.settingsChanged,
						...found.filter((item) => !project.settingsChanged?.includes(item)),
					],
					token: this.tokens.issue(windowId, path),
				},
			}
		if (found.length > 0)
			return { ...project, riskySettings: { found, token: this.tokens.issue(windowId, path) } }
		// A picked folder is trusted by the pick itself. A known folder reaches here only
		// after the in-app dialog, whose confirmation the renderer reported.
		return this.deps.trust(project.id)
	}
}
