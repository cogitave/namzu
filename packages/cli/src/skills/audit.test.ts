import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { auditFileSkills } from './audit.js'

const roots: string[] = []

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-skill-audit-'))
	roots.push(root)
	const cwd = join(root, 'project')
	const home = join(root, 'home')
	const systemDir = join(root, 'system')
	for (const dir of [cwd, home, systemDir]) mkdirSync(dir, { recursive: true })
	const write = (name: string, contents: string): void => {
		const dir = join(cwd, '.namzu', 'skills', name)
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'SKILL.md'), contents)
	}
	return { cwd, home, systemDir, write }
}

afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

it('reports what the SDK loader would refuse while preserving operator-only and disabled skills', async () => {
	const f = fixture()
	f.write('ready', '---\nname: ready\ndescription: a valid skill\n---\nBody')
	f.write('legacy', 'Body without frontmatter')
	f.write('wrong', '---\nname: other\ndescription: wrong directory\n---\nBody')
	f.write(
		'operator',
		'---\nname: operator\ndescription: user only\ninvocation: operator\n---\nBody',
	)
	f.write('disabled', '---\nname: disabled\ndescription: switched off\n---\nBody')
	const report = await auditFileSkills({
		cwd: f.cwd,
		home: f.home,
		systemDir: f.systemDir,
		config: { disabled: ['disabled'] },
	})
	expect(report).toMatchObject({ ready: 1, invalid: 2, operatorOnly: 1, disabled: 1 })
	expect(report.findings.find((finding) => finding.name === 'legacy')).toMatchObject({
		status: 'invalid',
		reason: expect.stringContaining('has no YAML frontmatter'),
	})
	expect(report.findings.find((finding) => finding.path.endsWith('/wrong/SKILL.md'))).toMatchObject(
		{
			status: 'invalid',
			reason: expect.stringContaining('must match directory name'),
		},
	)
	expect(report.findings.find((finding) => finding.name === 'disabled')?.status).toBe('disabled')
})

it('estimates the same first-overflow order as the turn manifest', async () => {
	const f = fixture()
	for (const name of ['a', 'b', 'c']) {
		f.write(name, `---\nname: ${name}\ndescription: a useful skill\n---\nBody`)
	}
	const report = await auditFileSkills({
		cwd: f.cwd,
		home: f.home,
		systemDir: f.systemDir,
		contextWindowTokens: 1000,
	})
	expect(report.manifestBudgetChars).toBe(80)
	expect(report.manifestChars).toBeGreaterThan(80)
	expect(report.overflow).toEqual(['a', 'b', 'c'])
})
