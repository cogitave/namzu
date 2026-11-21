import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceInUseError, generateWorkspaceId } from '@namzu/sdk'
import type { WorkspaceRef } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { runCli } from '../../cli.js'
import { openManagedWorktrees } from '../../integrations/worktrees/managed.js'

const roots: string[] = []
const initialCwd = process.cwd()

afterEach(() => {
	process.chdir(initialCwd)
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	for (const root of roots.splice(0)) removeTempDir(root)
})

/** A one-commit repository and a fresh Namzu state root, with the CLI's JSON output captured. */
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-worktree-command-\u001b[31m-'))
	roots.push(root)
	const repo = join(root, 'repo')
	const home = join(root, 'state')
	mkdirSync(repo)
	mkdirSync(home)
	execFileSync('git', ['-C', repo, 'init', '-q'])
	writeFileSync(join(repo, 'README.md'), 'ready\n')
	execFileSync('git', ['-C', repo, 'add', 'README.md'])
	execFileSync('git', [
		'-C',
		repo,
		'-c',
		'user.name=Namzu Test',
		'-c',
		'user.email=test@example.com',
		'commit',
		'-qm',
		'initial',
	])
	process.chdir(repo)
	vi.stubEnv('NAMZU_HOME', home)
	let stdout = ''
	let stderr = ''
	vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
		stdout += String(chunk)
		return true
	})
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
		stderr += String(chunk)
		return true
	})
	const invoke = async (...args: string[]) => {
		stdout = ''
		stderr = ''
		const code = await runCli({
			argv: ['node', 'namzu', '--format', 'json', 'worktree', ...args],
		})
		return {
			code,
			output: stdout ? (JSON.parse(stdout) as Record<string, unknown>) : null,
			stderr,
		}
	}
	return { repo, home, invoke }
}

it('routes create, list and resume through the real CLI with structured output', async () => {
	const { invoke } = await fixture()
	const created = await invoke('create', 'review')
	expect(created.code).toBe(0)
	expect(created.output?.branch).toBe('namzu/review')
	expect(created.output?.text).toContain('\\u{001b}')
	expect(created.output?.text).not.toContain('\u001b')
	const listed = await invoke('list')
	expect(listed.code).toBe(0)
	expect(listed.output?.worktrees).toMatchObject([{ label: 'review' }])
	const resumed = await invoke('resume', 'review')
	expect(resumed.code).toBe(0)
	expect(resumed.output?.worktree).toMatchObject({ label: 'review' })
	const wrong = await invoke('create', '../escape')
	expect(wrong.code).toBe(64)
	expect(wrong.stderr).toContain('worktree name')
})

it('keeps a checkout a running session is working in, and names both folders', async () => {
	const { repo, invoke } = await fixture()
	const created = await invoke('create', 'review')
	expect(created.code).toBe(0)
	const checkout = created.output?.path as string
	const manager = await openManagedWorktrees(repo)
	expect((await manager.checkoutAt(join(checkout, 'packages', 'sdk')))?.label).toBe('review')

	const folder = join(checkout, 'packages', 'sdk')
	const release = await manager.hold('review', 'session:4242', folder)
	const ref: WorkspaceRef = {
		id: generateWorkspaceId(),
		meta: {
			backend: 'git-worktree',
			repoRoot: repo,
			branch: 'namzu/review',
			worktreePath: checkout,
		},
		createdAt: new Date(),
	}
	const failure = await manager.workspaceDriver.dispose(ref).catch((error: unknown) => error)
	expect(failure).toBeInstanceOf(WorkspaceInUseError)
	expect((failure as Error).message).toContain(checkout)
	expect((failure as Error).message).toContain(folder)
	expect(existsSync(checkout)).toBe(true)

	await release()
	await manager.workspaceDriver.dispose(ref)
	expect(existsSync(checkout)).toBe(false)
})