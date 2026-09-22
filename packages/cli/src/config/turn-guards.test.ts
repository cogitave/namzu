import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { loadConfig } from './load.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

function fixture(limits: Record<string, unknown>) {
	const root = mkdtempSync(join(tmpdir(), 'namzu-config-limits-'))
	roots.push(root)
	const home = join(root, 'home')
	const cwd = join(root, 'workspace')
	mkdirSync(join(home, '.namzu'), { recursive: true })
	mkdirSync(cwd)
	writeFileSync(
		join(home, '.namzu/config.yaml'),
		'limits:\n  tokenBudget: 1000\n  maxIterations: 5\n  timeoutMs: 5000\n',
	)
	writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify({ limits }))
	return { home, cwd, env: {} }
}

it('zero removes inherited run caps without disabling accounting', () => {
	expect(loadConfig(fixture({ tokenBudget: 0, maxIterations: 0, timeoutMs: 0 })).limits).toEqual({
		tokenBudget: 0,
		maxIterations: 0,
		timeoutMs: 0,
	})
})

it.each([-1, 1.5, null, 'unlimited', Number.MAX_SAFE_INTEGER + 1])(
	'rejects invalid configured run limits: %j',
	(value) => {
		for (const key of ['tokenBudget', 'maxIterations', 'timeoutMs']) {
			expect(() => loadConfig(fixture({ [key]: value }))).toThrow(`limits.${key}`)
		}
	},
)

it('rejects turn deadlines that overflow platform timers instead of timing out immediately', () => {
	expect(() => loadConfig(fixture({ timeoutMs: 2_147_483_648 }))).toThrow('limits.timeoutMs')
})
