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
	private ready?: Promise<{
		sourceRoot: string
		subdirectory: string
		worktreesDir: string
		driver: WorkspaceBackendDriver
		isGit: boolean
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
		const { sourceRoot, worktreesDir, driver, isGit } = await this.open()
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
			return await driver.create({ ...params, ...(baseRef !== undefined ? { baseRef } : {}) })
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

	async dispose(ref: WorkspaceRef): Promise<void> {
		try {
			return await (await this.open()).driver.dispose(ref)
		} catch (cause) {
			// The caller only logs a failed removal; a person must read why a hook
			// that was to remove their worktree could not.
			this.say(cause)
			throw cause
		}
	}
}
