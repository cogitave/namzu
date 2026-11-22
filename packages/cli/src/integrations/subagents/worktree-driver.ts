/** Git checkout selection for a delegated child, resolved only when requested. */

import { execFile } from 'node:child_process'
import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
	BranchWorkspaceParams,
	CreateWorkspaceParams,
	WorkspaceBackendDriver,
	WorkspaceInspection,
	WorkspaceRef,
	WorktreeHookHost,
} from '@namzu/sdk'
import { openManagedWorktrees } from '../worktrees/managed.js'

const runFile = promisify(execFile)

export class DelegatedWorktreeDriver {
	readonly kind = 'git-worktree' as const
	/** What this process's children have open, released when a child's checkout ends. */
	private readonly holding = new Map<string, () => Promise<void>>()
	private ready?: Promise<{
		sourceRoot: string
		subdirectory: string
		worktreesDir: string
		driver: WorkspaceBackendDriver
		isGit: boolean
		hold: (label: string, holder: string, folder: string) => Promise<() => Promise<void>>
	}>

	constructor(
		private readonly cwd: string,
		private readonly stateRoot?: string,
		/**
		 * The `worktree_create` and `worktree_remove` hooks of the session, found
		 * when a worktree is made or removed, and where a line for the person goes.
		 */
		private readonly hooks?: {
			readonly host: () => WorktreeHookHost | undefined
			readonly onNotice: (line: string) => void
		},
	) {}

	private async open() {
		this.ready ??= openManagedWorktrees(this.cwd, {
			stateRoot: this.stateRoot,
			...(this.hooks ? { hooks: this.hooks.host, onNotice: this.hooks.onNotice } : {}),
		})
			.then(async (managed) => {
				const selectedDirectory = await realpath(resolve(this.cwd))
				const subdirectory = managed.isGit ? relative(managed.sourceRoot, selectedDirectory) : ''
				if (
					isAbsolute(subdirectory) ||
					subdirectory === '..' ||
					subdirectory.startsWith(`..${sep}`)
				) {
					throw new Error('Selected directory is outside its Git checkout')
				}
				return {
					sourceRoot: managed.sourceRoot,
					subdirectory,
					worktreesDir: managed.worktreesDir,
					// Hooks first, the kernel's Git logic otherwise: one driver for both.
					driver: managed.workspaceDriver,
					isGit: managed.isGit,
					hold: (label, holder, folder) => managed.hold(label, holder, folder),
				}
			})
			.catch((error) => {
				// A failed first attempt does not pin the runtime outside Git forever.
				this.ready = undefined
				throw error
			})
		return this.ready
	}

	/** A failure a hook caused is a line for the person, in the hook's own words. */
	private say(cause: unknown): void {
		if (this.hooks && cause instanceof Error && cause.name === 'WorktreeHookError') {
			this.hooks.onNotice(cause.message)
		}
	}

	/** Preserve the selected cwd beneath its checkout root for child execution. */
	async selectedSubdirectory(): Promise<string | undefined> {
		return (await this.open()).subdirectory || undefined
	}

	async create(params: CreateWorkspaceParams): Promise<WorkspaceRef> {
		const { sourceRoot, worktreesDir, driver, isGit, hold } = await this.open()
		// The selected checkout can itself be a linked worktree. The SDK driver's
		// repository root is the main checkout for ownership, but its default
		// HEAD would be the wrong starting commit for this child.
		// Outside Git only a hook can make the worktree, and there is no commit to start from.
		const head = isGit
			? (await runFile('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'])).stdout.trim()
			: undefined
		await mkdir(worktreesDir, { recursive: true, mode: 0o700 })
		const baseRef = params.baseRef ?? head
		try {
			const ref = await driver.create({ ...params, ...(baseRef !== undefined ? { baseRef } : {}) })
			// Publish that a child is working in its checkout, so a removal from
			// another terminal that picked that path out of `namzu worktree list` is
			// refused rather than deleting the child's files. A failure to record
			// this never fails the child: the checkout exists and works in full.
			try {
				const label = relative(worktreesDir, ref.meta.worktreePath).split(sep).join('/')
				this.holding.set(ref.id, await hold(label, `subagent:${label}`, ref.meta.worktreePath))
			} catch {
				// The child runs; nothing else changes.
			}
			return ref
		} catch (cause) {
			// The sub-agent's result tells the model why it did not start; the person
			// must read the hook's words too.
			this.say(cause)
			throw cause
		}
	}

	async branch(source: WorkspaceRef, params: BranchWorkspaceParams): Promise<WorkspaceRef> {
		return (await this.open()).driver.branch(source, params)
	}

	async inspect(ref: WorkspaceRef): Promise<WorkspaceInspection> {
		return (await this.open()).driver.inspect(ref)
	}

	/**
	 * The child that worked in a checkout has ended.
	 *
	 * Called whether or not the checkout is kept, so a checkout kept for review
	 * stops saying a subagent is working in it. Without this it would go on being
	 * refused by its own parent's holding — naming a `subagent:` that finished —
	 * for as long as this process lives, and the entry here would never be let go.
	 */
	async release(ref: WorkspaceRef): Promise<void> {
		const release = this.holding.get(ref.id)
		this.holding.delete(ref.id)
		if (release) await release().catch(() => undefined)
	}

	async dispose(ref: WorkspaceRef): Promise<void> {
		try {
			// The child is done before its checkout is: release first, so the removal
			// this process asks for is not refused by its own holding.
			await this.release(ref)
			return await (await this.open()).driver.dispose(ref)
		} catch (cause) {
			// The caller only logs a failed removal; a person must read why a hook
			// that was to remove their worktree could not.
			this.say(cause)
			throw cause
		}
	}
}
