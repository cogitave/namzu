/** Git checkout selection for a delegated child, resolved only when requested. */

import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import { GitWorktreeDriver, type WorkspaceRef } from '@namzu/sdk'
import { cliLogger } from '../../logging.js'
import { openManagedWorktrees } from '../worktrees/managed.js'

const runFile = promisify(execFile)

export class DelegatedWorktreeDriver {
	readonly kind = 'git-worktree' as const
	private ready?: Promise<{
		sourceRoot: string
		worktreesDir: string
		driver: GitWorktreeDriver
	}>

	constructor(
		private readonly cwd: string,
		private readonly stateRoot?: string,
	) {}

	private async open() {
		this.ready ??= openManagedWorktrees(this.cwd, {
			stateRoot: this.stateRoot,
		})
			.then((managed) => ({
				sourceRoot: managed.sourceRoot,
				worktreesDir: managed.worktreesDir,
				driver: new GitWorktreeDriver({
					repoRoot: managed.repoRoot,
					worktreesDir: managed.worktreesDir,
					logger: cliLogger(),
				}),
			}))
			.catch((error) => {
				// A failed first attempt does not pin the runtime outside Git forever.
				this.ready = undefined
				throw error
			})
		return this.ready
	}

	async create(params: Parameters<GitWorktreeDriver['create']>[0]): Promise<WorkspaceRef> {
		const { sourceRoot, worktreesDir, driver } = await this.open()
		// The selected checkout can itself be a linked worktree. The SDK driver's
		// repository root is the main checkout for ownership, but its default
		// HEAD would be the wrong starting commit for this child.
		const head = (await runFile('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'])).stdout.trim()
		await mkdir(worktreesDir, { recursive: true, mode: 0o700 })
		return driver.create({ ...params, baseRef: params.baseRef ?? head })
	}

	async branch(
		source: WorkspaceRef,
		params: Parameters<GitWorktreeDriver['branch']>[1],
	): Promise<WorkspaceRef> {
		return (await this.open()).driver.branch(source, params)
	}

	async inspect(ref: WorkspaceRef): ReturnType<GitWorktreeDriver['inspect']> {
		return (await this.open()).driver.inspect(ref)
	}

	async dispose(ref: WorkspaceRef): Promise<void> {
		return (await this.open()).driver.dispose(ref)
	}
}
