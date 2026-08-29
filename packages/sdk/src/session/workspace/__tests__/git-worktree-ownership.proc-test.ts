import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceRef } from '../../../types/workspace/ref.js'
import { WorkspaceBackendError } from '../../errors.js'
import { GitWorktreeDriver } from '../git-worktree.js'

const run = promisify(execFile)

function stubLogger() {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child() {
			return stubLogger()
		},
	}
}

async function git(...args: string[]): Promise<string> {
	return (await run('git', args, { encoding: 'utf8' })).stdout
}

describe('the Git worktree driver owns one canonical directory', () => {
	let root: string
	let repo: string
	let managed: string

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'namzu-worktree-owner-'))
		repo = join(root, 'repo')
		managed = join(root, 'managed')
		await git('init', '-q', '-b', 'main', repo)
		await git('-C', repo, 'config', 'user.name', 'Namzu test')
		await git('-C', repo, 'config', 'user.email', 'test@example.invalid')
		await git('-C', repo, 'commit', '--allow-empty', '-qm', 'initial')
		await mkdir(managed)
	})

	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	it.runIf(process.platform !== 'win32')(
		'refuses to remove an external registered worktree through a managed symlink',
		async () => {
			const external = join(root, 'external')
			await git('-C', repo, 'worktree', 'add', '-qb', 'namzu/link', external)
			await symlink(external, join(managed, 'link'), 'dir')
			const driver = new GitWorktreeDriver({
				repoRoot: repo,
				worktreesDir: managed,
				logger: stubLogger(),
			})
			const forged: WorkspaceRef = {
				id: 'wsp_forged' as unknown as WorkspaceRef['id'],
				createdAt: new Date(),
				meta: {
					backend: 'git-worktree',
					repoRoot: repo,
					branch: 'namzu/link',
					worktreePath: join(managed, 'link'),
				},
			}

			await expect(driver.dispose(forged)).rejects.toBeInstanceOf(WorkspaceBackendError)
			await expect(access(external)).resolves.toBeUndefined()
			expect(await git('-C', repo, 'worktree', 'list', '--porcelain')).toContain(
				`worktree ${external}`,
			)
		},
	)

	it.runIf(process.platform !== 'win32')(
		'refuses to create through a symlink below the managed root',
		async () => {
			const outside = join(root, 'outside')
			await mkdir(outside)
			await symlink(outside, join(managed, 'nested'), 'dir')
			const driver = new GitWorktreeDriver({
				repoRoot: repo,
				worktreesDir: managed,
				logger: stubLogger(),
			})

			await expect(driver.create({ label: 'nested/child' })).rejects.toBeInstanceOf(
				WorkspaceBackendError,
			)
			await expect(access(join(outside, 'child'))).rejects.toMatchObject({ code: 'ENOENT' })
			expect(await git('-C', repo, 'worktree', 'list', '--porcelain')).not.toContain(
				'refs/heads/namzu/nested/child',
			)
		},
	)

	it.runIf(process.platform !== 'win32')(
		'uses the canonical path it checked when the configured root is a symlink',
		async () => {
			const physicalRoot = join(root, 'physical-managed')
			const rootAlias = join(root, 'managed-alias')
			await mkdir(physicalRoot)
			await symlink(physicalRoot, rootAlias, 'dir')
			const calls: string[][] = []
			const driver = new GitWorktreeDriver({
				repoRoot: repo,
				worktreesDir: rootAlias,
				logger: stubLogger(),
				execFile: async (file, args) => {
					calls.push([...args])
					const result = await run(file, [...args], { encoding: 'utf8' })
					return { stdout: result.stdout, stderr: result.stderr }
				},
			})

			const ref = await driver.create({ label: 'nested/child' })

			expect(ref.meta.worktreePath).toBe(join(physicalRoot, 'nested', 'child'))
			expect(await driver.inspect(ref)).toMatchObject({ exists: true, isDirty: false })
			await driver.dispose({
				...ref,
				meta: { ...ref.meta, worktreePath: join(rootAlias, 'nested', 'child') },
			})
			const removeCall = calls.find((args) => args.includes('remove'))
			expect(removeCall).toContain(join(physicalRoot, 'nested', 'child'))
			expect(removeCall).not.toContain(join(rootAlias, 'nested', 'child'))
			await expect(access(ref.meta.worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })
		},
	)

	it('treats an option-shaped base ref as a ref, not as a Git option', async () => {
		const driver = new GitWorktreeDriver({
			repoRoot: repo,
			worktreesDir: managed,
			logger: stubLogger(),
		})

		await expect(
			driver.create({ label: 'option-shaped', baseRef: '--no-checkout' }),
		).rejects.toBeInstanceOf(WorkspaceBackendError)
		await expect(access(join(managed, 'option-shaped'))).rejects.toMatchObject({ code: 'ENOENT' })
	})

	it('does not mistake an unavailable repository for an already-gone worktree', async () => {
		const missingRepo = join(root, 'missing-repo')
		const missingManaged = join(missingRepo, '.namzu', 'worktrees')
		const driver = new GitWorktreeDriver({
			repoRoot: missingRepo,
			worktreesDir: missingManaged,
			logger: stubLogger(),
		})
		const ref: WorkspaceRef = {
			id: 'wsp_missing' as unknown as WorkspaceRef['id'],
			createdAt: new Date(),
			meta: {
				backend: 'git-worktree',
				repoRoot: missingRepo,
				branch: 'namzu/x',
				worktreePath: join(missingManaged, 'x'),
			},
		}

		await expect(driver.dispose(ref)).rejects.toMatchObject({
			name: 'WorkspaceBackendError',
			details: { op: 'dispose:list' },
		})
	})
})
