/**
 * The built-in skill tier ships in the published tarball.
 *
 * `systemSkillsDir()` resolves `<package>/skills/` from the installed module,
 * so a `files` list that leaves the directory out makes every built-in skill
 * vanish from an installed CLI while every test run from the repository still
 * finds it. Asked of npm itself, the thing that builds the tarball.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { systemSkillsDir } from '../skills/store.js'

const packageRoot = fileURLToPath(new URL('../../', import.meta.url))

describe('the published @namzu/cli tarball', () => {
	it('contains skills/ and every built-in SKILL.md in it', () => {
		const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
			cwd: packageRoot,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			// `npm` is `npm.cmd` on Windows, which only a shell resolves.
			shell: process.platform === 'win32',
		})
		const [pack] = JSON.parse(raw) as [{ files: { path: string }[] }]
		const files = pack.files.map((file) => file.path)

		expect(files).toContain('skills/README.md')
		const shipped = systemSkillsDir()
		expect(shipped).toBe(join(packageRoot, 'skills/'))
		for (const entry of readdirSync(shipped, { withFileTypes: true })) {
			if (!entry.isDirectory() || !existsSync(join(shipped, entry.name, 'SKILL.md'))) continue
			expect(files).toContain(`skills/${entry.name}/SKILL.md`)
		}
	}, 60_000)
})
