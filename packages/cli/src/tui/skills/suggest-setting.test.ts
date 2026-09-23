import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { setSkillSuggestions } from './suggest-setting.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})
function dir(prefix: string): string {
	const made = mkdtempSync(join(tmpdir(), prefix))
	dirs.push(made)
	return made
}

function setup() {
	const home = dir('namzu-suggest-home-')
	const cwd = dir('namzu-suggest-cwd-')
	const managedPath = join(dir('namzu-suggest-managed-'), 'config.json')
	return { home, cwd, managedPath, opts: { cwd, env: { NAMZU_HOME: home }, managedPath } }
}

describe('setSkillSuggestions', () => {
	it('writes the user file and says so when nothing overrides it', () => {
		const { home, opts } = setup()
		const result = setSkillSuggestions(false, opts)
		expect(result.effective).toBe(false)
		expect(result.message).toContain(`Saved skills.suggest: false to ${join(home, 'config.yaml')}`)
		expect(result.message).not.toContain('replaces')
		expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('suggest: false')
	})

	it('names a project skills block that hides the user value', () => {
		const { cwd, opts } = setup()
		const project = join(cwd, 'namzu.config.json')
		writeFileSync(project, JSON.stringify({ skills: { disabled: ['noisy'] } }))
		const result = setSkillSuggestions(false, opts)
		expect(result.effective).toBe(true)
		expect(result.message).toContain(`project-file ${project}`)
		expect(result.message).toContain('from the next start skills.suggest will be true')
		expect(result.message).toContain('Add suggest: false under skills there')
		expect(result.message).toContain('this session follows your choice')
	})

	it('names a managed skills block that sets the opposite', () => {
		const { opts, managedPath } = setup()
		writeFileSync(managedPath, JSON.stringify({ skills: { suggest: false } }))
		const result = setSkillSuggestions(true, opts)
		expect(result.effective).toBe(false)
		expect(result.message).toContain(`managed ${managedPath}`)
		expect(result.message).toContain('will be false')
	})

	it('stays quiet when the overriding block already agrees', () => {
		const { cwd, opts } = setup()
		writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify({ skills: { suggest: false } }))
		const result = setSkillSuggestions(false, opts)
		expect(result.effective).toBe(false)
		expect(result.message).not.toContain('replaces')
	})

	it('says it could not check when another file does not load', () => {
		const { cwd, opts } = setup()
		writeFileSync(join(cwd, 'namzu.config.json'), '{ broken')
		const result = setSkillSuggestions(false, opts)
		expect(result.file).toBeDefined()
		expect(result.message).toContain('Could not check the other config files')
	})

	it('reports a user file it cannot write, and writes nothing', () => {
		const { home, opts } = setup()
		writeFileSync(join(home, 'config.yaml'), 'skills: [\n')
		const result = setSkillSuggestions(false, opts)
		expect(result.file).toBeUndefined()
		expect(result.message).toContain('Could not save skills.suggest')
		expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe('skills: [\n')
	})
})
