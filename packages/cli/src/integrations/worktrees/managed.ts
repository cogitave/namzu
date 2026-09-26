/** CLI-owned, durable Git worktrees. The SDK driver enforces path and branch ownership. */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, mkdir, readdir, realpath, rmdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { GitWorktreeDriver, asSessionId, generateWorkspaceId } from '@namzu/sdk'
import type { WorkspaceRef } from '@namzu/sdk'
import { cliLogger } from '../../logging.js'
import {
	activeConversationTurn,
	closeSessions,
	forkConversationInto,
	listRecent,
	loadResumableConversation,
	openSessions,
} from '../sessions/store.js'

const runFile = promisify(execFile)

export interface ManagedWorktree {
	readonly label: string
	readonly path: string
	readonly branch: string
	readonly dirty: boolean
}

export interface CreatedWorktree extends ManagedWorktree {
	readonly sourceDirty: boolean
}

export interface WorktreeFork extends CreatedWorktree {
	readonly conversationId: string
	readonly title: string
	readonly copied: number
}

export interface WorktreeResume {
	readonly worktree: ManagedWorktree
	readonly conversationId?: string
	readonly title?: string
}

export interface ManagedWorktreesOptions {
	/** Exact Namzu state root for an embedding or integration test. */
	readonly stateRoot?: string
}

/** A copyable command for the host shell; no path is interpreted by the agent. */
export function worktreeOpenHint(path: string, conversationId?: string): string {
	const quoted =
		process.platform === 'win32'
			? `'${path.replaceAll("'", "''")}'`
			: `'${path.replaceAll("'", "'\\''")}'`
	const launch = `namzu${conversationId ? ` resume ${conversationId}` : ''}`
	return process.platform === 'win32'
		? `Set-Location -LiteralPath ${quoted}; if ($?) { ${launch} }`
		: `cd ${quoted} && ${launch}`
}

/** Only one path component and one branch component; no Git or shell syntax. */
function checkedLabel(value: string): string {
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
		throw new Error('A worktree name must use 1–64 lowercase letters, digits or hyphens.')
	}
	return value
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await runFile('git', ['-C', cwd, ...args])
	return stdout
}

/** Resolve the same main checkout from either it or one of its linked worktrees. */
export async function openManagedWorktrees(
	cwd: string,
	options: ManagedWorktreesOptions = {},
): Promise<ManagedWorktrees> {
	const directory = await realpath(resolve(cwd))
	let sourceRoot: string
	let repoRoot: string
	try {
		sourceRoot = await realpath((await git(directory, 'rev-parse', '--show-toplevel')).trim())
		const listing = await git(directory, 'worktree', 'list', '--porcelain', '-z')
		const first = listing.split('\0', 1)[0]
		if (!first?.startsWith('worktree ')) throw new Error('Git did not report a main checkout.')
		repoRoot = await realpath(first.slice('worktree '.length))
		const sourceCommon = await realpath(
			(await git(sourceRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim(),
		)
		const mainCommon = await realpath(
			(await git(repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim(),
		)
		if (sourceCommon !== mainCommon)
			throw new Error('The selected checkout belongs to another repository.')
	} catch (cause) {
		throw new Error(
			`Cannot manage worktrees here: ${cause instanceof Error ? cause.message : String(cause)}`,
		)
	}
	const sessions = await openSessions(repoRoot, options)
	const worktreesDir = sessions.paths.worktrees()
	closeSessions(sessions)
	try {
		const node = await lstat(worktreesDir)
		if (!node.isDirectory()) throw new Error('The managed worktree path is not a directory.')
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
	}
	return new ManagedWorktrees(
		repoRoot,
		sourceRoot,
		worktreesDir,
		new GitWorktreeDriver({ repoRoot, worktreesDir, logger: cliLogger() }),
		options,
	)
}

export class ManagedWorktrees {
	constructor(
		readonly repoRoot: string,
		readonly sourceRoot: string,
		readonly worktreesDir: string,
		private readonly driver: GitWorktreeDriver,
		private readonly options: ManagedWorktreesOptions,
	) {}

	private ref(label: string): WorkspaceRef {
		const checked = checkedLabel(label)
		return {
			id: generateWorkspaceId(),
			meta: {
				backend: 'git-worktree',
				repoRoot: this.repoRoot,
				branch: `namzu/${checked}`,
				worktreePath: join(this.worktreesDir, checked),
			},
			createdAt: new Date(),
		}
	}

	/** Registered Namzu-owned checkouts only; arbitrary folders are omitted. */
	async list(): Promise<ManagedWorktree[]> {
		let entries: Dirent[]
		try {
			entries = await readdir(this.worktreesDir, {
				withFileTypes: true,
				encoding: 'utf8',
			})
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
			throw cause
		}
		const found: ManagedWorktree[] = []
		for (const entry of entries) {
			if (!entry.isDirectory()) continue
			if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.name)) continue
			try {
				const worktree = await this.inspect(entry.name)
				if (worktree) found.push(worktree)
			} catch {
				// A directory with tampered ownership is never offered as a target.
			}
		}
		return found.sort((a, b) => a.label.localeCompare(b.label))
	}

	/** An exact label must still pass the SDK driver's ownership and Git registration checks. */
	async inspect(label: string): Promise<ManagedWorktree | null> {
		const ref = this.ref(label)
		const inspection = await this.driver.inspect(ref)
		return inspection.exists
			? {
					label,
					path: ref.meta.worktreePath,
					branch: ref.meta.branch,
					dirty: inspection.isDirty,
				}
			: null
	}

	/** Create at the selected checkout's committed HEAD, leaving its dirty files in place. */
	async create(label?: string): Promise<CreatedWorktree> {
		const name = checkedLabel(label ?? `work-${randomUUID().slice(0, 8)}`)
		const sourceDirty = (await git(this.sourceRoot, 'status', '--porcelain')).trim().length > 0
		const head = (await git(this.sourceRoot, 'rev-parse', 'HEAD')).trim()
		await mkdir(this.worktreesDir, { recursive: true, mode: 0o700 })
		// The SDK driver correctly recovers a new checkout after a failing
		// post-checkout hook, but the same evidence describes a pre-existing
		// checkout after `git worktree add` refused a duplicate. Serialize CLI
		// creators and reject that pre-existing case before asking the driver.
		const lockPath = join(this.worktreesDir, `.${name}.creating`)
		try {
			await mkdir(lockPath)
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
				throw new Error(`Worktree ${name} is already being created. Try another name.`)
			}
			throw cause
		}
		try {
			if (await this.inspect(name)) throw new Error(`Worktree ${name} already exists.`)
			const ref = await this.driver.create({ label: name, baseRef: head })
			const inspection = await this.driver.inspect(ref)
			if (!inspection.exists) {
				throw new Error(
					`Git reported a worktree at ${ref.meta.worktreePath}, but it is not registered.`,
				)
			}
			return {
				label: name,
				path: ref.meta.worktreePath,
				branch: ref.meta.branch,
				dirty: inspection.isDirty,
				sourceDirty,
			}
		} finally {
			await rmdir(lockPath)
		}
	}

	/** Fork the source checkout's settled conversation into the new checkout's Project. */
	async fork(sourceConversationId: string, label?: string): Promise<WorktreeFork> {
		const source = await openSessions(this.sourceRoot, this.options)
		try {
			const sourceId = asSessionId(sourceConversationId)
			const messages = await loadResumableConversation(source, sourceId)
			if (messages.length === 0) {
				throw new Error('There is nothing to fork yet — this conversation has no messages.')
			}
			if (await activeConversationTurn(source, sourceId)) {
				throw new Error('Wait for the current turn to finish before forking to a worktree.')
			}
			const created = await this.create(label)
			try {
				const target = await openSessions(created.path, this.options)
				try {
					const forked = await forkConversationInto(source, target, sourceId)
					return {
						...created,
						conversationId: forked.id,
						title: forked.title,
						copied: forked.copied,
					}
				} finally {
					closeSessions(target)
				}
			} catch (cause) {
				throw new Error(
					`Worktree ${created.path} was created, but its conversation copy failed: ${cause instanceof Error ? cause.message : String(cause)}. The worktree was kept for inspection.`,
				)
			}
		} finally {
			closeSessions(source)
		}
	}

	/** Resolve an owned checkout and one of its own conversations for a fresh TUI launch. */
	async resume(label: string, conversationId?: string): Promise<WorktreeResume> {
		const worktree = await this.inspect(label)
		if (!worktree) throw new Error(`No managed worktree named ${label} is registered here.`)
		const sessions = await openSessions(worktree.path, this.options)
		try {
			if (conversationId) {
				await loadResumableConversation(sessions, conversationId)
				return { worktree, conversationId }
			}
			const latest = (await listRecent(sessions, 1))[0]
			return latest ? { worktree, conversationId: latest.id, title: latest.title } : { worktree }
		} finally {
			closeSessions(sessions)
		}
	}
}
