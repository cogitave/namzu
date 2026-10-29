import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { runCli } from '../../cli.js'
import { parseInstallArgs } from '../github.js'

const roots: string[] = []
const initialCwd = process.cwd()
let stdout = ''
let stderr = ''
let repo = ''

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-github-command-'))
	roots.push(root)
	repo = join(root, 'repo')
	mkdirSync(repo)
	execFileSync('git', ['-C', repo, 'init', '-q'])
	process.chdir(repo)
	stdout = ''
	stderr = ''
	vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
		stdout += String(chunk)
		return true
	})
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
		stderr += String(chunk)
		return true
	})
})

afterEach(() => {
	process.chdir(initialCwd)
	vi.restoreAllMocks()
	for (const root of roots.splice(0)) removeTempDir(root)
})

const invoke = async (...args: string[]) => {
	stdout = ''
	stderr = ''
	const code = await runCli({ argv: ['node', 'namzu', 'github', ...args] })
	return { code, stdout, stderr }
}

const read = (path: string) => readFileSync(join(repo, path), 'utf8')

describe('namzu github install', () => {
	it('writes both workflows as valid YAML', async () => {
		const { code, stdout: out } = await invoke('install')

		expect(code).toBe(0)
		expect(out).toContain('.github/workflows/namzu.yml')
		expect(out).toContain('.github/workflows/namzu-review.yml')
		for (const file of ['namzu.yml', 'namzu-review.yml']) {
			const doc = parse(read(`.github/workflows/${file}`)) as { jobs: Record<string, unknown> }
			expect(Object.keys(doc.jobs).length).toBe(1)
		}
	})

	it('runs the CLI read-only, with a spend limit and the chosen provider key', async () => {
		await invoke('install', '--provider', 'openai', '--model', 'gpt-4o', '--budget', '3')

		const mention = read('.github/workflows/namzu.yml')
		expect(mention).toContain('npm install --global @namzu/cli@')
		expect(mention).toContain('--provider openai')
		expect(mention).toContain('--model gpt-4o')
		expect(mention).toContain('--max-budget-usd 3')
		expect(mention).toContain('--disallowed-tools "edit write"')
		expect(mention).toContain('OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}')
		expect(mention).toContain('contents: read')
	})

	it('names the secret the person chose', async () => {
		const { stdout: out } = await invoke('install', '--secret', 'TEAM_KEY')

		expect(read('.github/workflows/namzu.yml')).toContain(
			'ANTHROPIC_API_KEY: ${{ secrets.TEAM_KEY }}',
		)
		expect(out).toContain('gh secret set TEAM_KEY')
	})

	it('never puts text from an issue or comment into the shell script itself', async () => {
		await invoke('install')

		for (const file of ['namzu.yml', 'namzu-review.yml']) {
			const doc = parse(read(`.github/workflows/${file}`)) as {
				jobs: Record<string, { steps: { run?: string }[] }>
			}
			for (const job of Object.values(doc.jobs))
				for (const step of job.steps) expect(step.run ?? '').not.toContain('github.event')
		}
	})

	it('answers only owners, members and collaborators, and skips fork pull requests', async () => {
		await invoke('install')

		expect(read('.github/workflows/namzu.yml')).toContain('"OWNER","MEMBER","COLLABORATOR"')
		expect(read('.github/workflows/namzu-review.yml')).toContain(
			'head.repo.full_name == github.repository',
		)
	})

	it('gives the parsed jobs read-only contents and the expected guards', async () => {
		await invoke('install')

		type Doc = { jobs: Record<string, { if?: string; permissions: Record<string, string> }> }
		const mention = parse(read('.github/workflows/namzu.yml')) as Doc
		const review = parse(read('.github/workflows/namzu-review.yml')) as Doc
		const m = Object.values(mention.jobs)[0]
		const r = Object.values(review.jobs)[0]
		expect(m.permissions).toEqual({ contents: 'read', issues: 'write', 'pull-requests': 'write' })
		expect(m.if).toContain('"OWNER","MEMBER","COLLABORATOR"')
		expect(r.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' })
		expect(r.if).toContain('head.repo.full_name == github.repository')
	})

	it('writes only the workflow asked for', async () => {
		await invoke('install', '--workflow', 'review')

		expect(existsSync(join(repo, '.github/workflows/namzu-review.yml'))).toBe(true)
		expect(existsSync(join(repo, '.github/workflows/namzu.yml'))).toBe(false)
	})

	it('keeps a file that is already there until --force', async () => {
		mkdirSync(join(repo, '.github/workflows'), { recursive: true })
		writeFileSync(join(repo, '.github/workflows/namzu.yml'), 'mine\n')

		const kept = await invoke('install', '--workflow', 'mention')
		expect(kept.stdout).toContain('already exists, kept')
		expect(read('.github/workflows/namzu.yml')).toBe('mine\n')

		await invoke('install', '--workflow', 'mention', '--force')
		expect(read('.github/workflows/namzu.yml')).toContain('name: Namzu')
	})

	it('writes nothing on a dry run', async () => {
		const { code, stdout: out } = await invoke('install', '--dry-run')

		expect(code).toBe(0)
		expect(out).toContain('Would write')
		expect(existsSync(join(repo, '.github'))).toBe(false)
	})

	it('refuses outside a Git repository, in plain words', async () => {
		const outside = mkdtempSync(join(tmpdir(), 'namzu-github-outside-'))
		roots.push(outside)
		process.chdir(outside)

		const { code, stderr: err } = await invoke('install')

		expect(code).toBe(64)
		expect(err).toContain('not inside a Git repository')
	})

	it('refuses a provider that has no key a runner can read', async () => {
		const { code, stderr: err } = await invoke('install', '--provider', 'ollama')

		expect(code).toBe(64)
		expect(err).toContain('no API key a runner can read')
		expect(existsSync(join(repo, '.github'))).toBe(false)
	})

	it('refuses an unknown verb and an unknown option', async () => {
		expect((await invoke('uninstall')).code).toBe(64)
		expect((await invoke('install', '--wat')).code).toBe(64)
	})
})

describe('the install arguments', () => {
	it('default to both workflows, Anthropic and one dollar', () => {
		expect(parseInstallArgs([])).toEqual({
			workflows: ['mention', 'review'],
			provider: 'anthropic',
			model: undefined,
			secret: undefined,
			budgetUsd: 1,
			force: false,
			dryRun: false,
		})
	})

	it('reject a bad budget and a bad workflow name', () => {
		expect(parseInstallArgs(['--budget', '0'])).toHaveProperty('error')
		expect(parseInstallArgs(['--budget=abc'])).toHaveProperty('error')
		expect(parseInstallArgs(['--workflow', 'deploy'])).toHaveProperty('error')
		expect(parseInstallArgs(['--model'])).toHaveProperty('error')
	})
})
