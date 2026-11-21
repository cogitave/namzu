import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { decideHeadlessTrust } from '../permissions/headless-trust.js'

const dirs: string[] = []
afterEach(() => {
	vi.unstubAllEnvs()
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

it('says the trusted folders list could not be read, not that nobody trusted the folder', () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-headless-'))
	dirs.push(cwd)
	const decision = decideHeadlessTrust({
		cwd,
		trustFlag: false,
		trusted: () => false,
		listProblem: () => ({ file: '/h/.namzu/trust.json', reason: 'not valid JSON' }),
	})
	expect(decision.allowed).toBe(false)
	const message = decision.allowed ? '' : decision.message
	expect(message).toContain('the trusted folders list /h/.namzu/trust.json could not be read')
	expect(message).toContain('pass --trust')
	expect(message).not.toContain('nobody has trusted')
})

it('still says nobody trusted the folder when the list reads', () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-headless-'))
	dirs.push(cwd)
	const decision = decideHeadlessTrust({
		cwd,
		trustFlag: false,
		trusted: () => false,
		listProblem: () => undefined,
	})
	expect(decision.allowed ? '' : decision.message).toContain('nobody has trusted')
})

it('answers for the list from the caller that answers trust, never from the ambient home', () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-headless-'))
	const ambient = mkdtempSync(join(tmpdir(), 'namzu-headless-home-'))
	dirs.push(cwd, ambient)
	writeFileSync(join(ambient, 'trust.json'), '{ damaged')
	vi.stubEnv('NAMZU_HOME', ambient)
	const decision = decideHeadlessTrust({ cwd, trustFlag: false, trusted: () => false })
	expect(decision.allowed ? '' : decision.message).toContain('nobody has trusted')
})
