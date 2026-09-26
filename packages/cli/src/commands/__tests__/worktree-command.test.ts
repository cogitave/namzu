import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { runCli } from '../../cli.js'

const roots: string[] = []
const initialCwd = process.cwd()

afterEach(() => {
	process.chdir(initialCwd)
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	for (const root of roots.splice(0)) removeTempDir(root)
})

it('routes create, list and resume through the real CLI with structured output', async () => {
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
