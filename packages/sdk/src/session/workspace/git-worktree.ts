/**
 * GitWorktreeDriver — reference implementation of
 * {@link WorkspaceBackendDriver} backed by `git worktree`.
 *
 * See session-hierarchy.md §7.2 (Git-worktree reference backend).
 *
 * Safety: every subprocess invocation uses `execFile` with an argv array —
 * no shell interpolation — so caller-supplied `label`/`baseRef` strings
 * cannot escape their argument slot. Failures surface as
 * {@link WorkspaceBackendError} carrying the underlying cause.
 */

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { generateWorkspaceId } from '../../utils/id.js'
import type { Logger } from '../../utils/logger.js'
import { WorkspaceBackendError } from '../errors.js'
import type {
	BranchWorkspaceParams,
	CreateWorkspaceParams,
	WorkspaceBackendDriver,
	WorkspaceInspection,
} from './driver.js'
import type { GitWorktreeBackendMeta, WorkspaceRef } from './ref.js'

const execFileAsync = promisify(execFile)

/**
 * Minimal shape of `execFile`'s promisified result — allows tests to stub
 * via dependency injection without pulling in the full `ChildProcess` type.
 */
export interface ExecFileResult {
	stdout: string
	stderr: string
}

/**
 * Async exec callable used by {@link GitWorktreeDriver}. Matches the shape
 * of `promisify(execFile)` for the argv-array overload. Injected via the
 * constructor so tests can stub without touching `child_process`.
 */
export type ExecFile = (file: string, args: readonly string[]) => Promise<ExecFileResult>

const defaultExecFile: ExecFile = async (file, args) => execFileAsync(file, [...args])

/**
 * Configuration for {@link GitWorktreeDriver}.
 */
export interface GitWorktreeDriverConfig {
	/** Absolute path to the repo root whose `.git` backs the worktrees. */
	repoRoot: string
	/**
	 * Directory (absolute) where worktree checkouts live. Defaults to
	 * `{repoRoot}/.namzu/worktrees` per session-hierarchy.md §7.2.
	 */
	worktreesDir?: string
	logger: Logger
	/** Test-seam: inject a stub `execFile` implementation. */
	execFile?: ExecFile
}

export class GitWorktreeDriver implements WorkspaceBackendDriver {
	readonly kind = 'git-worktree' as const

	private readonly repoRoot: string
	private readonly worktreesDir: string
	private readonly log: Logger
	private readonly exec: ExecFile

	constructor(config: GitWorktreeDriverConfig) {
		this.repoRoot = config.repoRoot
		this.worktreesDir = config.worktreesDir ?? join(config.repoRoot, '.namzu', 'worktrees')
		this.log = config.logger.child({ component: 'GitWorktreeDriver' })
		this.exec = config.execFile ?? defaultExecFile
	}

	async create(params: CreateWorkspaceParams): Promise<WorkspaceRef> {
		const id = generateWorkspaceId()
		const label = params.label ?? id
		const branch = `namzu/${label}`
		const worktreePath = join(this.worktreesDir, label)

		const argv = ['-C', this.repoRoot, 'worktree', 'add', '-b', branch, worktreePath]
		if (params.baseRef !== undefined) {
			argv.push(params.baseRef)
		}

		try {
			await this.exec('git', argv)
		} catch (cause) {
			throw new WorkspaceBackendError({ op: 'create', kind: this.kind, cause })
		}

		const meta: GitWorktreeBackendMeta = {
			backend: 'git-worktree',
			repoRoot: this.repoRoot,
			branch,
			worktreePath,
		}

		this.log.info('git-worktree created', { id, branch, worktreePath })
		return {
			id,
			meta,
			createdAt: new Date(),
		}
	}

	async branch(source: WorkspaceRef, params: BranchWorkspaceParams): Promise<WorkspaceRef> {
		// Branch from the source worktree's current branch. The source's
		// `meta.branch` is the ref we base off.
		return this.create({ baseRef: source.meta.branch, label: params.label })
	}

	async dispose(ref: WorkspaceRef): Promise<void> {
		// Tolerate missing directories per roadmap Risk #3 mitigation: the
		// broadcast-rollback compensating step calls dispose on partially
		// provisioned refs and must not propagate "already gone" errors.
		try {
			await this.exec('git', [
				'-C',
				this.repoRoot,
				'worktree',
				'remove',
				ref.meta.worktreePath,
				'--force',
			])
			this.log.info('git-worktree disposed', { id: ref.id, path: ref.meta.worktreePath })
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause)
			// git exits non-zero with "is not a working tree" when the path is
			// absent; treat as idempotent success and log at debug.
			if (/not a working tree|does not exist|No such file/i.test(message)) {
				this.log.debug('git-worktree already gone; dispose idempotent', {
					id: ref.id,
					path: ref.meta.worktreePath,
				})
				return
			}
			throw new WorkspaceBackendError({ op: 'dispose', kind: this.kind, cause })
		}
	}

	async inspect(ref: WorkspaceRef): Promise<WorkspaceInspection> {
		let listStdout: string
		try {
			const result = await this.exec('git', [
				'-C',
				this.repoRoot,
				'worktree',
				'list',
				'--porcelain',
			])
			listStdout = result.stdout
		} catch (cause) {
			throw new WorkspaceBackendError({ op: 'inspect:list', kind: this.kind, cause })
		}

		const entry = parseWorktreeList(listStdout, ref.meta.worktreePath)
		if (!entry) {
			return { exists: false, currentRef: ref.meta.branch, isDirty: false }
		}

		let statusStdout: string
		try {
			const result = await this.exec('git', ['-C', ref.meta.worktreePath, 'status', '--porcelain'])
			statusStdout = result.stdout
		} catch (cause) {
			throw new WorkspaceBackendError({ op: 'inspect:status', kind: this.kind, cause })
		}

		return {
			exists: true,
			currentRef: entry.branch ?? entry.head ?? ref.meta.branch,
			isDirty: statusStdout.trim().length > 0,
		}
	}
}

/**
 * Parses `git worktree list --porcelain` output, returning the record for
 * `worktreePath` or `null` when absent. Exported for tests.
 */
export function parseWorktreeList(
	stdout: string,
	worktreePath: string,
): { path: string; head?: string; branch?: string } | null {
	const blocks = stdout.split(/\n\n+/)
	for (const block of blocks) {
		const lines = block.split('\n').filter((l) => l.length > 0)
		let path: string | undefined
		let head: string | undefined
		let branch: string | undefined
		for (const line of lines) {
			if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
			else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
			else if (line.startsWith('branch ')) branch = line.slice('branch '.length)
		}
		if (path === worktreePath) {
			return {
				path,
				...(head !== undefined && { head }),
				...(branch !== undefined && { branch }),
			}
		}
	}
	return null
}
