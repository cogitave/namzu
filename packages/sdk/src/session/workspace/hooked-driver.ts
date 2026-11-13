/**
 * HookedWorkspaceDriver: lets `worktree_create` and `worktree_remove` hooks
 * take over a workspace driver.
 *
 * The kernel makes worktrees with its own Git logic. A person whose checkout
 * needs something else (another version-control tool, a prepared checkout, a
 * plain copy) puts a hook on `worktree_create`; the hook makes the folder and
 * answers with its path, and the kernel uses it. A hook on `worktree_remove`
 * does the removing. With no hook on an event, the wrapped driver does what it
 * always did.
 *
 * Hooks decide, so a failure never falls back behind the person's back:
 * - hooks on `worktree_create` that fail, or none of which gives a path, fail
 *   the creation with the hook's own words;
 * - hooks on `worktree_remove` that fail fail the removal, unless nothing is
 *   left at the path;
 * - a folder a create hook made carries `meta.hookOwned`: the kernel never runs
 *   its Git removal on it. With no remove hook it is left, and the person is
 *   told where.
 */

import { createHash } from 'node:crypto'
import { lstat, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { SessionId } from '../../types/ids/index.js'
import type { PluginHookResult } from '../../types/plugin/index.js'
import type { WorkspaceRef } from '../../types/workspace/ref.js'
import { generateWorkspaceId } from '../../utils/id.js'
import type {
	BranchWorkspaceParams,
	CreateWorkspaceParams,
	WorkspaceBackendDriver,
	WorkspaceInspection,
} from './driver.js'

/** What a worktree event carries. */
export interface WorktreeHookContext {
	readonly worktreeName?: string
	readonly worktreeRoot?: string
	readonly worktreeBaseRef?: string
	readonly worktreePath?: string
}

/** Runs the hooks of one event and returns their answers (none when no hook is attached). */
export interface WorktreeHookHost {
	execute(
		event: 'worktree_create' | 'worktree_remove',
		context: WorktreeHookContext,
	): Promise<readonly PluginHookResult[]>
}

/** Binds a lifecycle manager (or anything with its `executeHooks`) to a session. */
export function worktreeHookHost(
	manager: {
		executeHooks(
			event: 'worktree_create' | 'worktree_remove',
			context: WorktreeHookContext & { sessionId: SessionId },
		): Promise<PluginHookResult[]>
	},
	sessionId: () => string,
): WorktreeHookHost {
	return {
		execute: (event, context) =>
			manager.executeHooks(event, { ...context, sessionId: sessionId() as SessionId }),
	}
}

/** A failure whose message is the sentence the person should read. */
export class WorktreeHookError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'WorktreeHookError'
	}
}

export interface HookedWorkspaceDriverOptions {
	readonly inner: WorkspaceBackendDriver
	/** The hooks, or a function that finds them when a worktree is made (a host initializes plugins late). */
	readonly hooks: WorktreeHookHost | (() => WorktreeHookHost | undefined)
	/** The folder the kernel would have placed the worktree under; a relative answer is placed there. */
	readonly root: () => string | Promise<string>
	/** The repository recorded on a ref a hook made. Defaults to `root`. */
	readonly repoRoot?: () => string | Promise<string>
	/** A line for the person (a folder left in place, a second answer ignored). */
	readonly onNotice?: (line: string) => void
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory()
	} catch {
		return false
	}
}

async function isGone(path: string): Promise<boolean> {
	try {
		await stat(path)
		return false
	} catch (cause) {
		return (cause as NodeJS.ErrnoException).code === 'ENOENT'
	}
}

/** The most entries looked at to tell whether a hook's folder changed; more reads as "changed". */
export const MAX_FINGERPRINT_ENTRIES = 20_000

/**
 * A digest of the names, sizes and times of everything under a folder, or
 * `undefined` when it cannot be taken (too many entries, unreadable). A change
 * of any file, however small, changes it.
 */
async function fingerprint(root: string): Promise<string | undefined> {
	const lines: string[] = []
	const walk = async (dir: string, prefix: string): Promise<boolean> => {
		const entries = await readdir(dir, { withFileTypes: true })
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		for (const entry of entries) {
			if (lines.length >= MAX_FINGERPRINT_ENTRIES) return false
			const path = join(dir, entry.name)
			const info = await lstat(path)
			lines.push(`${prefix}${entry.name}:${info.isDirectory() ? 'd' : info.size}:${info.mtimeMs}`)
			if (info.isDirectory() && !(await walk(path, `${prefix}${entry.name}/`))) return false
		}
		return true
	}
	try {
		if (!(await walk(root, ''))) return undefined
	} catch {
		return undefined
	}
	return createHash('sha1').update(lines.join('\n')).digest('hex')
}

export class HookedWorkspaceDriver implements WorkspaceBackendDriver {
	readonly kind: WorkspaceBackendDriver['kind']
	/** What each hook-made folder looked like when its hook finished, by workspace id. */
	private readonly started = new Map<string, string | undefined>()

	constructor(private readonly options: HookedWorkspaceDriverOptions) {
		this.kind = options.inner.kind
	}

	private host(): WorktreeHookHost | undefined {
		const { hooks } = this.options
		return typeof hooks === 'function' ? hooks() : hooks
	}

	async create(params: CreateWorkspaceParams): Promise<WorkspaceRef> {
		return this.make(params, () => this.options.inner.create(params))
	}

	async branch(source: WorkspaceRef, params: BranchWorkspaceParams): Promise<WorkspaceRef> {
		const request: CreateWorkspaceParams = {
			...(params.label !== undefined ? { label: params.label } : {}),
			baseRef: source.meta.branch,
		}
		return this.make(request, async () => {
			if (source.meta.hookOwned === true) {
				throw new WorktreeHookError(
					`The worktree at ${source.meta.worktreePath} was made by a worktree_create hook, and no worktree_create hook is attached now, so a branch of it cannot be made.`,
				)
			}
			return this.options.inner.branch(source, params)
		})
	}

	private async make(
		params: CreateWorkspaceParams,
		kernel: () => Promise<WorkspaceRef>,
	): Promise<WorkspaceRef> {
		const host = this.host()
		if (host === undefined) return kernel()
		const root = await this.options.root()
		const name = params.label ?? `worktree-${generateWorkspaceId()}`
		const results = await host.execute('worktree_create', {
			worktreeName: name,
			worktreeRoot: root,
			...(params.baseRef !== undefined ? { worktreeBaseRef: params.baseRef } : {}),
		})
		// No hook is attached to the event: the kernel makes it, as it always did.
		if (results.length === 0) return kernel()

		const failures = results.flatMap((result) =>
			result.action === 'error' ? [result.message] : [],
		)
		if (failures.length > 0) throw new WorktreeHookError(failures.join(' '))
		const answers = results.flatMap((result) =>
			'worktreePath' in result && result.worktreePath !== undefined ? [result.worktreePath] : [],
		)
		const given = answers[0]
		if (given === undefined) {
			throw new WorktreeHookError(
				'The hooks on worktree_create gave no worktree path, so none was created. A hook prints the folder it made as its last line, or answers JSON with hookSpecificOutput.worktreePath.',
			)
		}
		if (answers.length > 1) {
			this.options.onNotice?.(
				`More than one worktree_create hook gave a path; the first, ${given}, is used.`,
			)
		}
		const path = isAbsolute(given) ? resolve(given) : resolve(root, given)
		if (!(await isDirectory(path))) {
			throw new WorktreeHookError(
				`A worktree_create hook gave ${given}${path === given ? '' : ` (${path})`}, which is not a folder that exists, so no worktree was created.`,
			)
		}
		const id = generateWorkspaceId()
		this.started.set(id, await fingerprint(path))
		return {
			id,
			meta: {
				backend: 'git-worktree',
				repoRoot: resolve(await (this.options.repoRoot ?? this.options.root)()),
				branch: name,
				worktreePath: path,
				hookOwned: true,
			},
			createdAt: new Date(),
		}
	}

	async dispose(ref: WorkspaceRef): Promise<void> {
		const host = this.host()
		this.started.delete(ref.id)
		const results =
			host === undefined
				? []
				: await host.execute('worktree_remove', { worktreePath: ref.meta.worktreePath })
		if (results.length === 0) {
			if (ref.meta.hookOwned === true) {
				// Made by a hook: the kernel has no removal of its own for it.
				this.options.onNotice?.(
					`The worktree at ${ref.meta.worktreePath} was made by a worktree_create hook and is left in place: no worktree_remove hook is set. Remove it yourself when you are done with it.`,
				)
				return
			}
			return this.options.inner.dispose(ref)
		}
		const failures = results.flatMap((result) =>
			result.action === 'error' ? [result.message] : [],
		)
		if (failures.length === 0) return
		// A hook that failed after finishing its job leaves nothing to remove.
		if (await isGone(ref.meta.worktreePath)) return
		throw new WorktreeHookError(failures.join(' '))
	}

	async inspect(ref: WorkspaceRef): Promise<WorkspaceInspection> {
		if (ref.meta.hookOwned !== true) return this.options.inner.inspect(ref)
		const exists = await isDirectory(ref.meta.worktreePath)
		if (!exists) return { exists, currentRef: ref.meta.branch, isDirty: false }
		// Git cannot say whether a hook's folder changed. What can is the folder
		// itself: it is unchanged only when it looks exactly as it did when the
		// hook finished. Anything else, or no record of that moment (another
		// process made it, or it was too large to take), reads as changed, so a
		// caller deciding whether to keep it keeps it.
		const before = this.started.get(ref.id)
		const unchanged = before !== undefined && before === (await fingerprint(ref.meta.worktreePath))
		if (!unchanged) {
			this.options.onNotice?.(
				`The worktree at ${ref.meta.worktreePath} was made by a worktree_create hook and has changes (or could not be compared), so it is kept.`,
			)
		}
		return {
			exists,
			currentRef: ref.meta.branch,
			isDirty: !unchanged,
			hasNewCommits: !unchanged,
		}
	}
}
