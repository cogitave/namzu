/**
 * GitWorktreeDriver — reference implementation of
 * {@link WorkspaceBackendDriver} backed by `git worktree`.
 *
 * See session-hierarchy.md §7.2 (Git-worktree reference backend).
 *
 * Safety: every subprocess invocation uses `execFile` with an argv array and
 * separates caller-controlled positional arguments from Git options with
 * `--`. Filesystem paths are canonicalized and confined to the configured
 * worktree root before Git receives them. Failures surface as
 * {@link WorkspaceBackendError} carrying the underlying cause.
 */

import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { NAMZU } from '../../constants/telemetry/index.js'
import type { GitWorktreeBackendMeta, WorkspaceRef } from '../../types/workspace/ref.js'
import { generateWorkspaceId } from '../../utils/id.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import type { Logger } from '../../utils/logger.js'
import { WorkspaceBackendError } from '../errors.js'
import type {
	BranchWorkspaceParams,
	CreateWorkspaceParams,
	WorkspaceBackendDriver,
	WorkspaceInspection,
} from './driver.js'

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
		this.repoRoot = resolve(config.repoRoot)
		this.worktreesDir = resolve(config.worktreesDir ?? join(config.repoRoot, '.namzu', 'worktrees'))
		this.log = config.logger.child({ [SCOPE_ATTRIBUTE]: 'session/workspace/git-worktree' })
		this.exec = config.execFile ?? defaultExecFile
	}

	async create(params: CreateWorkspaceParams): Promise<WorkspaceRef> {
		const id = generateWorkspaceId()
		const label = params.label ?? id
		let repoRoot: string
		let worktreesDir: string
		let worktreePath: string
		try {
			repoRoot = await canonicalizeThroughExisting(this.repoRoot)
			worktreesDir = await canonicalizeThroughExisting(this.worktreesDir)
			const lexicalPath = resolve(worktreesDir, label)
			if (!isStrictDescendant(worktreesDir, lexicalPath)) {
				throw new Error(`Workspace label escapes the managed worktree directory: ${label}`)
			}
			worktreePath = await canonicalizeThroughExisting(lexicalPath)
			if (!isStrictDescendant(worktreesDir, worktreePath)) {
				throw new Error(
					`Workspace label resolves through a link outside the managed worktree directory: ${label}`,
				)
			}
			if (relative(worktreesDir, lexicalPath) !== relative(worktreesDir, worktreePath)) {
				throw new Error(
					`Workspace label resolves through a link to a different managed path: ${label}`,
				)
			}
		} catch (cause) {
			throw new WorkspaceBackendError({ op: 'create:ownership', kind: this.kind, cause })
		}

		const relativePath = relative(worktreesDir, worktreePath).split(sep).join('/')
		const branch = `namzu/${relativePath}`

		// `--` belongs before caller-controlled positional arguments. Without it,
		// a base ref such as `--no-checkout` is accepted as a Git option and the
		// driver publishes a checkout containing only its `.git` link.
		const argv = ['-C', repoRoot, 'worktree', 'add', '-b', branch, '--', worktreePath]
		if (params.baseRef !== undefined) {
			argv.push(params.baseRef)
		}

		try {
			await this.exec('git', argv)
		} catch (cause) {
			// A non-zero exit here does not mean the worktree was not created.
			// `git worktree add` runs the repository's post-checkout hook AFTER
			// the checkout has completed, so a hook that fails — or that a
			// timeout kills — reports failure over a worktree that is finished
			// and usable. Treating the status as the answer throws away a good
			// checkout AND leaks it: the path stays registered, and the next
			// attempt fails differently, with "already exists".
			//
			// So the exit code is a hint and the repository is the evidence.
			// The bar is deliberately high: registered under this exact path
			// AND carrying the branch this call asked for. A registered path
			// alone can be a half-finished checkout, or somebody else's.
			if (!(await this.createdDespite(repoRoot, worktreePath, branch))) {
				throw new WorkspaceBackendError({ op: 'create', kind: this.kind, cause })
			}
			this.log.warn('git-worktree add reported failure but the worktree is present', {
				'namzu.session.branch': branch,
				'namzu.session.worktree_path': worktreePath,
				'namzu.session.cause': cause instanceof Error ? cause.message : String(cause),
			})
		}

		const meta: GitWorktreeBackendMeta = {
			backend: 'git-worktree',
			repoRoot,
			branch,
			worktreePath,
		}

		this.log.info('git-worktree created', {
			[NAMZU.SESSION_ID]: id,
			'namzu.session.branch': branch,
			'namzu.session.worktree_path': worktreePath,
		})
		return {
			id,
			meta,
			createdAt: new Date(),
		}
	}

	async branch(source: WorkspaceRef, params: BranchWorkspaceParams): Promise<WorkspaceRef> {
		// Branch from the source worktree's current branch. The source's
		// `meta.branch` is the ref we base off.
		const owned = await this.requireOwnedRef(source, 'branch')
		return this.create({ baseRef: owned.branch, label: params.label })
	}

	async dispose(ref: WorkspaceRef): Promise<void> {
		const owned = await this.requireOwnedRef(ref, 'dispose')
		const registered = await this.registeredEntry(owned, 'dispose:list')
		if (!registered) {
			this.log.debug('git-worktree already gone; dispose idempotent', {
				[NAMZU.SESSION_ID]: ref.id,
				'namzu.session.path': owned.worktreePath,
			})
			return
		}

		// Tolerate missing directories per roadmap Risk #3 mitigation: the
		// broadcast-rollback compensating step calls dispose on partially
		// provisioned refs and must not propagate "already gone" errors. The
		// repository list, rather than an error-message regex, is the evidence:
		// an unavailable repository can contain the same "No such file" words.
		try {
			await this.exec('git', [
				'-C',
				owned.repoRoot,
				'worktree',
				'remove',
				owned.worktreePath,
				'--force',
			])
			this.log.info('git-worktree disposed', {
				[NAMZU.SESSION_ID]: ref.id,
				'namzu.session.path': owned.worktreePath,
			})
		} catch (cause) {
			// Two concurrent disposals can both observe the entry before one wins.
			// Re-read after failure and accept only repository evidence that the
			// exact owned branch/path pair is now absent.
			const nowRegistered = await this.registeredEntry(owned, 'dispose:recheck').catch(
				() => undefined,
			)
			if (nowRegistered === null) {
				this.log.debug('git-worktree already gone; dispose idempotent', {
					[NAMZU.SESSION_ID]: ref.id,
					'namzu.session.path': owned.worktreePath,
				})
				return
			}
			throw new WorkspaceBackendError({ op: 'dispose', kind: this.kind, cause })
		}
	}

	/**
	 * Did the worktree arrive despite the command reporting failure?
	 *
	 * Answers only for the branch this call created. A path registered
	 * without that branch is not this call's worktree — it is a leftover
	 * from a killed attempt, or a checkout somebody else owns, and the two
	 * are indistinguishable from here. Claiming either would mean handing
	 * a caller a workspace whose contents nobody vouched for, so both are
	 * left to surface as the failure they are.
	 *
	 * Any error while checking is itself a "no". This runs on a path that
	 * has already gone wrong once, and guessing optimistically there is how
	 * a recovery turns a bad situation into a wrong one.
	 */
	private async createdDespite(
		repoRoot: string,
		worktreePath: string,
		branch: string,
	): Promise<boolean> {
		try {
			const { stdout } = await this.exec('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'])
			const entry = parseWorktreeList(stdout, worktreePath)
			// `--porcelain` writes the branch as a full ref (`refs/heads/x`),
			// and `branch` here is the short name this call passed to `-b`.
			// Comparing them directly is a check that can never pass, which
			// would make this whole recovery path silently dead — the exact
			// shape it exists to catch.
			return entry?.branch === `refs/heads/${branch}`
		} catch {
			return false
		}
	}

	async inspect(ref: WorkspaceRef): Promise<WorkspaceInspection> {
		const owned = await this.requireOwnedRef(ref, 'inspect')
		let listStdout: string
		try {
			const result = await this.exec('git', [
				'-C',
				owned.repoRoot,
				'worktree',
				'list',
				'--porcelain',
			])
			listStdout = result.stdout
		} catch (cause) {
			throw new WorkspaceBackendError({ op: 'inspect:list', kind: this.kind, cause })
		}

		const entry = parseWorktreeList(listStdout, owned.worktreePath)
		if (!entry || entry.branch !== `refs/heads/${owned.branch}`) {
			return { exists: false, currentRef: owned.branch, isDirty: false }
		}

		let statusStdout: string
		try {
			const result = await this.exec('git', ['-C', owned.worktreePath, 'status', '--porcelain'])
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

	/**
	 * Turn persisted metadata back into an owned driver capability.
	 *
	 * A WorkspaceRef is recovery data, not authority to make this driver act on
	 * any worktree registered in the same repository. Existing links are
	 * resolved before the boundary is decided, and every Git call receives the
	 * canonical path that was checked. This closes static symlink escapes. It
	 * does not claim protection from a host process concurrently swapping path
	 * components or mount points; the Git CLI exposes no descriptor-relative
	 * removal primitive with which to make that guarantee.
	 */
	private async requireOwnedRef(ref: WorkspaceRef, op: string): Promise<GitWorktreeBackendMeta> {
		try {
			if (ref.meta.backend !== this.kind) {
				throw new Error(`Workspace backend ${ref.meta.backend} does not belong to ${this.kind}`)
			}

			const repoRoot = await canonicalizeThroughExisting(this.repoRoot)
			const refRepoRoot = await canonicalizeThroughExisting(ref.meta.repoRoot)
			if (refRepoRoot !== repoRoot) {
				throw new Error('Workspace reference belongs to a different repository')
			}

			const worktreesDir = await canonicalizeThroughExisting(this.worktreesDir)
			const worktreePath = await canonicalizeThroughExisting(ref.meta.worktreePath)
			if (!isStrictDescendant(worktreesDir, worktreePath)) {
				throw new Error('Workspace reference escapes the managed worktree directory')
			}

			const label = relative(worktreesDir, worktreePath).split(sep).join('/')
			const branch = `namzu/${label}`
			if (ref.meta.branch !== branch) {
				throw new Error('Workspace reference branch does not match its managed path')
			}

			return {
				backend: 'git-worktree',
				repoRoot,
				branch,
				worktreePath,
			}
		} catch (cause) {
			throw new WorkspaceBackendError({ op: `${op}:ownership`, kind: this.kind, cause })
		}
	}

	private async registeredEntry(
		owned: GitWorktreeBackendMeta,
		op: string,
	): Promise<{ path: string; head?: string; branch?: string } | null> {
		let stdout: string
		try {
			const result = await this.exec('git', [
				'-C',
				owned.repoRoot,
				'worktree',
				'list',
				'--porcelain',
			])
			stdout = result.stdout
		} catch (cause) {
			throw new WorkspaceBackendError({ op, kind: this.kind, cause })
		}

		const entry = parseWorktreeList(stdout, owned.worktreePath)
		return entry?.branch === `refs/heads/${owned.branch}` ? entry : null
	}
}

/** Resolve every existing path component, preserving only a missing suffix. */
async function canonicalizeThroughExisting(input: string): Promise<string> {
	let existing = resolve(input)
	const remainder: string[] = []

	for (;;) {
		try {
			const canonical = await realpath(existing)
			return resolve(canonical, ...remainder)
		} catch (cause) {
			const code = (cause as NodeJS.ErrnoException).code
			if (code !== 'ENOENT' && code !== 'ENOTDIR') throw cause
		}

		const parent = dirname(existing)
		if (parent === existing) return resolve(existing, ...remainder)
		remainder.unshift(basename(existing))
		existing = parent
	}
}

function isStrictDescendant(root: string, candidate: string): boolean {
	const rel = relative(root, candidate)
	return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
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
