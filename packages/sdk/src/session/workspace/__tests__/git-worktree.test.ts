import { describe, expect, it, vi } from 'vitest'
import { WorkspaceBackendError } from '../../errors.js'
import {
	type ExecFile,
	type ExecFileResult,
	GitWorktreeDriver,
	parseWorktreeList,
} from '../git-worktree.js'
import type { WorkspaceRef } from '../ref.js'

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
		expect(call.args).toEqual([
			'-C',
			'/repo',
			'worktree',
			'add',
			'-b',
			'namzu/foo',
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
		expect(call.args.at(-1)).toBe('/repo/.namzu/worktrees/bar')
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

	it('dispose: removes worktree with --force', async () => {
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
		expect(calls[0]).toEqual([
			'-C',
			'/repo',
			'worktree',
			'remove',
			'/repo/.namzu/worktrees/x',
			'--force',
		])
	})

	it('dispose: tolerates missing worktree ("not a working tree")', async () => {
		const exec: ExecFile = async () => {
			throw new Error("'/tmp/gone' is not a working tree")
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
				worktreePath: '/tmp/gone',
			},
			createdAt: new Date(),
		}
		// Must NOT throw — roadmap Risk #3 mitigation.
		await expect(driver.dispose(ref)).resolves.toBeUndefined()
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
