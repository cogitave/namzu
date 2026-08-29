import { describe, expect, it, vi } from 'vitest'
import { posix } from '../../../test-support/paths.js'
import type { WorkspaceRef } from '../../../types/workspace/ref.js'
import { WorkspaceBackendError } from '../../errors.js'
import {
	type ExecFile,
	type ExecFileResult,
	GitWorktreeDriver,
	parseWorktreeList,
} from '../git-worktree.js'

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

function okExec(stdout = '', stderr = ''): ExecFileResult {
	return { stdout, stderr }
}

function listedWorktree(path: string, branch: string): string {
	return [`worktree ${path}`, 'HEAD abc123', `branch refs/heads/${branch}`, ''].join('\n')
}

describe('GitWorktreeDriver', () => {
	it('create: invokes `git worktree add` with argv array (no shell interpolation)', async () => {
		const calls: Array<{ file: string; args: readonly string[] }> = []
		const exec: ExecFile = async (file, args) => {
			calls.push({ file, args: [...args] })
			return okExec()
		}
		const driver = new GitWorktreeDriver({
			repoRoot: '/repo',
			logger: stubLogger(),
			execFile: exec,
		})
		const ref = await driver.create({ label: 'foo', baseRef: 'main' })

		expect(ref.id.startsWith('wsp_')).toBe(true)
		expect(ref.meta.backend).toBe('git-worktree')
		expect(ref.meta.branch).toBe('namzu/foo')
		expect(calls).toHaveLength(1)
		const call = calls[0]
		if (!call) throw new Error('missing call')
		expect(call.file).toBe('git')
		// `posix()` per element: the worktree path is built with `path.join`,
		// so it is backslash-separated on Windows. The assertion is about
		// argv shape and ordering, not separator style.
		expect(call.args.map(posix)).toEqual([
			'-C',
			'/repo',
			'worktree',
			'add',
			'-b',
			'namzu/foo',
			'--',
			'/repo/.namzu/worktrees/foo',
			'main',
		])
	})

	it('create: omits baseRef argv slot when not supplied', async () => {
		const calls: Array<{ file: string; args: readonly string[] }> = []
		const exec: ExecFile = async (file, args) => {
			calls.push({ file, args: [...args] })
			return okExec()
		}
		const driver = new GitWorktreeDriver({
			repoRoot: '/repo',
			logger: stubLogger(),
			execFile: exec,
		})
		await driver.create({ label: 'bar' })
		const call = calls[0]
		if (!call) throw new Error('missing call')
		expect(posix(call.args.at(-1))).toBe('/repo/.namzu/worktrees/bar')
	})

	it('create: wraps failures in WorkspaceBackendError', async () => {
		const exec: ExecFile = async () => {
			throw new Error('invalid baseRef')
		}
		const driver = new GitWorktreeDriver({
			repoRoot: '/repo',
			logger: stubLogger(),
			execFile: exec,
		})
		await expect(driver.create({ baseRef: 'does-not-exist' })).rejects.toBeInstanceOf(
			WorkspaceBackendError,
		)
	})

	it.each(['', '..', '../outside', '/outside'])(
		'create: refuses non-descendant label %j before invoking Git',
		async (label) => {
			const exec = vi.fn(async () => okExec())
			const driver = new GitWorktreeDriver({
				repoRoot: '/repo',
				logger: stubLogger(),
				execFile: exec,
			})

			await expect(driver.create({ label })).rejects.toBeInstanceOf(WorkspaceBackendError)
			expect(exec).not.toHaveBeenCalled()
		},
	)

	it('dispose: removes worktree with --force', async () => {
		const calls: Array<readonly string[]> = []
		const exec: ExecFile = async (_file, args) => {
			calls.push(args)
			return args.includes('list')
				? okExec(listedWorktree('/repo/.namzu/worktrees/x', 'namzu/x'))
				: okExec()
		}
		const driver = new GitWorktreeDriver({
			repoRoot: '/repo',
			logger: stubLogger(),
			execFile: exec,
		})
		const ref: WorkspaceRef = {
			id: 'wsp_x' as unknown as WorkspaceRef['id'],
			meta: {
				backend: 'git-worktree',
				repoRoot: '/repo',
				branch: 'namzu/x',
				worktreePath: '/repo/.namzu/worktrees/x',
			},
			createdAt: new Date(),
		}
		await driver.dispose(ref)
		expect(calls).toEqual([
			['-C', '/repo', 'worktree', 'list', '--porcelain'],
			['-C', '/repo', 'worktree', 'remove', '/repo/.namzu/worktrees/x', '--force'],
		])
	})

	it('dispose: treats an unregistered managed worktree as already gone', async () => {
		const exec = vi.fn(async () => okExec())
		const driver = new GitWorktreeDriver({
			repoRoot: '/repo',
			logger: stubLogger(),
			execFile: exec,
		})
		const ref: WorkspaceRef = {
			id: 'wsp_x' as unknown as WorkspaceRef['id'],
			meta: {
				backend: 'git-worktree',
				repoRoot: '/repo',
				branch: 'namzu/x',
				worktreePath: '/repo/.namzu/worktrees/x',
			},
			createdAt: new Date(),
		}
		// Must NOT throw — roadmap Risk #3 mitigation.
		await expect(driver.dispose(ref)).resolves.toBeUndefined()
		expect(exec).toHaveBeenCalledOnce()
	})

	it.each([
		{
			name: 'a path outside the managed directory',
			repoRoot: '/repo',
			branch: 'namzu/external',
			worktreePath: '/external',
		},
		{
			name: 'a sibling-prefix directory',
			repoRoot: '/repo',
			branch: 'namzu/x',
			worktreePath: '/repo/.namzu/worktrees-other/x',
		},
		{
			name: 'the managed root itself',
			repoRoot: '/repo',
			branch: 'namzu/worktrees',
			worktreePath: '/repo/.namzu/worktrees',
		},
		{
			name: 'a different repository',
			repoRoot: '/other',
			branch: 'namzu/x',
			worktreePath: '/repo/.namzu/worktrees/x',
		},
		{
			name: 'a branch inconsistent with its managed path',
			repoRoot: '/repo',
			branch: 'main',
			worktreePath: '/repo/.namzu/worktrees/x',
		},
	])('dispose: refuses $name before invoking Git', async (meta) => {
		const exec = vi.fn(async () => okExec())
		const driver = new GitWorktreeDriver({
			repoRoot: '/repo',
			logger: stubLogger(),
			execFile: exec,
		})
		const ref: WorkspaceRef = {
			id: 'wsp_foreign' as unknown as WorkspaceRef['id'],
			meta: { backend: 'git-worktree', ...meta },
			createdAt: new Date(),
		}

		await expect(driver.dispose(ref)).rejects.toBeInstanceOf(WorkspaceBackendError)
		expect(exec).not.toHaveBeenCalled()
	})

	it('branch: accepts a nested managed ref and separates its base ref from Git options', async () => {
		const calls: Array<readonly string[]> = []
		const exec: ExecFile = async (_file, args) => {
			calls.push(args)
			return okExec()
		}
		const driver = new GitWorktreeDriver({
			repoRoot: '/repo',
			logger: stubLogger(),
			execFile: exec,
		})
		const source: WorkspaceRef = {
			id: 'wsp_nested' as unknown as WorkspaceRef['id'],
			meta: {
				backend: 'git-worktree',
				repoRoot: '/repo',
				branch: 'namzu/parent/child',
				worktreePath: '/repo/.namzu/worktrees/parent/child',
			},
			createdAt: new Date(),
		}

		await driver.branch(source, { label: 'next' })

		expect(calls).toHaveLength(1)
		expect(calls[0]?.map(posix)).toEqual([
			'-C',
			'/repo',
			'worktree',
			'add',
			'-b',
			'namzu/next',
			'--',
			'/repo/.namzu/worktrees/next',
			'namzu/parent/child',
		])
	})

	it.each(['branch', 'inspect'] as const)(
		'%s: refuses a foreign ref before invoking Git',
		async (operation) => {
			const exec = vi.fn(async () => okExec())
			const driver = new GitWorktreeDriver({
				repoRoot: '/repo',
				logger: stubLogger(),
				execFile: exec,
			})
			const foreign: WorkspaceRef = {
				id: 'wsp_foreign' as unknown as WorkspaceRef['id'],
				meta: {
					backend: 'git-worktree',
					repoRoot: '/repo',
					branch: 'namzu/external',
					worktreePath: '/external',
				},
				createdAt: new Date(),
			}

			const result =
				operation === 'branch' ? driver.branch(foreign, { label: 'next' }) : driver.inspect(foreign)
			await expect(result).rejects.toBeInstanceOf(WorkspaceBackendError)
			expect(exec).not.toHaveBeenCalled()
		},
	)

	it('dispose: remains idempotent when another disposer wins after the list', async () => {
		let listCalls = 0
		const exec = vi.fn(async (_file: string, args: readonly string[]) => {
			if (args.includes('list')) {
				listCalls++
				return listCalls === 1
					? okExec(listedWorktree('/repo/.namzu/worktrees/x', 'namzu/x'))
					: okExec()
			}
			throw new Error('another disposer removed it first')
		})
		const driver = new GitWorktreeDriver({
			repoRoot: '/repo',
			logger: stubLogger(),
			execFile: exec,
		})
		const ref: WorkspaceRef = {
			id: 'wsp_x' as unknown as WorkspaceRef['id'],
			meta: {
				backend: 'git-worktree',
				repoRoot: '/repo',
				branch: 'namzu/x',
				worktreePath: '/repo/.namzu/worktrees/x',
			},
			createdAt: new Date(),
		}

		await expect(driver.dispose(ref)).resolves.toBeUndefined()
		expect(exec).toHaveBeenCalledTimes(3)
	})

	it('dispose: surfaces unexpected failures as WorkspaceBackendError', async () => {
		const exec: ExecFile = async () => {
			throw new Error('fatal: permission denied')
		}
		const driver = new GitWorktreeDriver({
			repoRoot: '/repo',
			logger: stubLogger(),
			execFile: exec,
		})
		const ref: WorkspaceRef = {
			id: 'wsp_x' as unknown as WorkspaceRef['id'],
			meta: {
				backend: 'git-worktree',
				repoRoot: '/repo',
				branch: 'namzu/x',
				worktreePath: '/repo/.namzu/worktrees/x',
			},
			createdAt: new Date(),
		}
		await expect(driver.dispose(ref)).rejects.toBeInstanceOf(WorkspaceBackendError)
	})

	it('inspect: parses list output and detects clean tree', async () => {
		const listStdout = [
			'worktree /repo/.namzu/worktrees/x',
			'HEAD abc123',
			'branch refs/heads/namzu/x',
			'',
		].join('\n')
		let callIndex = 0
		const exec: ExecFile = async (_file, args) => {
			callIndex++
			if (args.includes('list')) return okExec(listStdout)
			if (args.includes('status')) return okExec('')
			throw new Error(`unexpected call ${callIndex}`)
		}
		const driver = new GitWorktreeDriver({
			repoRoot: '/repo',
			logger: stubLogger(),
			execFile: exec,
		})
		const ref: WorkspaceRef = {
			id: 'wsp_x' as unknown as WorkspaceRef['id'],
			meta: {
				backend: 'git-worktree',
				repoRoot: '/repo',
				branch: 'namzu/x',
				worktreePath: '/repo/.namzu/worktrees/x',
			},
			createdAt: new Date(),
		}
		const inspection = await driver.inspect(ref)
		expect(inspection.exists).toBe(true)
		expect(inspection.isDirty).toBe(false)
	})

	it('inspect: reports dirty when status --porcelain has output', async () => {
		const listStdout = [
			'worktree /repo/.namzu/worktrees/x',
			'HEAD abc123',
			'branch refs/heads/namzu/x',
			'',
		].join('\n')
		const exec: ExecFile = async (_file, args) => {
			if (args.includes('list')) return okExec(listStdout)
			if (args.includes('status')) return okExec(' M path/to/file\n')
			throw new Error('unexpected')
		}
		const driver = new GitWorktreeDriver({
			repoRoot: '/repo',
			logger: stubLogger(),
			execFile: exec,
		})
		const ref: WorkspaceRef = {
			id: 'wsp_x' as unknown as WorkspaceRef['id'],
			meta: {
				backend: 'git-worktree',
				repoRoot: '/repo',
				branch: 'namzu/x',
				worktreePath: '/repo/.namzu/worktrees/x',
			},
			createdAt: new Date(),
		}
		const inspection = await driver.inspect(ref)
		expect(inspection.isDirty).toBe(true)
	})

	it('inspect: does not enter a path now registered to another branch', async () => {
		const exec = vi.fn(async () =>
			okExec(listedWorktree('/repo/.namzu/worktrees/x', 'namzu/someone-else')),
		)
		const driver = new GitWorktreeDriver({
			repoRoot: '/repo',
			logger: stubLogger(),
			execFile: exec,
		})
		const ref: WorkspaceRef = {
			id: 'wsp_x' as unknown as WorkspaceRef['id'],
			meta: {
				backend: 'git-worktree',
				repoRoot: '/repo',
				branch: 'namzu/x',
				worktreePath: '/repo/.namzu/worktrees/x',
			},
			createdAt: new Date(),
		}

		await expect(driver.inspect(ref)).resolves.toEqual({
			exists: false,
			currentRef: 'namzu/x',
			isDirty: false,
		})
		expect(exec).toHaveBeenCalledOnce()
	})
})

describe('parseWorktreeList', () => {
	it('returns null when the target path is absent', () => {
		const stdout = ['worktree /other', 'HEAD abc', 'branch refs/heads/main', ''].join('\n')
		expect(parseWorktreeList(stdout, '/missing')).toBeNull()
	})

	it('extracts head + branch for the matching entry', () => {
		const stdout = [
			'worktree /repo/.namzu/worktrees/x',
			'HEAD deadbeef',
			'branch refs/heads/namzu/x',
			'',
			'worktree /other',
			'HEAD abc',
			'bare',
			'',
		].join('\n')
		const entry = parseWorktreeList(stdout, '/repo/.namzu/worktrees/x')
		expect(entry).toEqual({
			path: '/repo/.namzu/worktrees/x',
			head: 'deadbeef',
			branch: 'refs/heads/namzu/x',
		})
	})
})
