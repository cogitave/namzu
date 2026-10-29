import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { loadConfig } from './load.js'
import { resolveTurnGuards } from './turn-guards.js'

const roots: string[] = []

it('overlays the output and compact-window exports without erasing sibling file settings', () => {
	const options = fixture({ tokenBudget: 12000, maxIterations: 7, maxResponseTokens: 8192 })
	writeFileSync(
		join(options.cwd, 'namzu.config.json'),
		JSON.stringify({
			limits: { tokenBudget: 12000, maxIterations: 7, maxResponseTokens: 8192 },
			compaction: { strategy: 'structured', contextWindowTokens: 1_048_576 },
		}),
	)
	const config = loadConfig({
		...options,
		env: { NAMZU_MAX_OUTPUT_TOKENS: '32768', NAMZU_AUTO_COMPACT_WINDOW: '786432' },
	})
	expect(config.limits).toMatchObject({
		tokenBudget: 12000,
		maxIterations: 7,
		maxResponseTokens: 32768,
	})
	expect(config.compaction).toEqual({
		strategy: 'structured',
		contextWindowTokens: 1_048_576,
		autoCompactWindowTokens: 786432,
	})
})

it.each(['0', '-1', '1.5', 'no', '9007199254740992'])(
	'refuses invalid exported output/compact sizes: %j',
	(value) => {
		for (const name of ['NAMZU_MAX_OUTPUT_TOKENS', 'NAMZU_AUTO_COMPACT_WINDOW'])
			expect(() => loadConfig({ ...fixture({}), env: { [name]: value } })).toThrow(name)
	},
)
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

it('loads a per-call output allowance without changing aggregate turn budgets', () => {
	const limits = loadConfig(fixture({ maxResponseTokens: 32_768 })).limits
	expect(limits?.maxResponseTokens).toBe(32_768)
	expect(resolveTurnGuards({ tokenBudget: 1000, maxIterations: 5 }, limits)).toMatchObject({
		maxResponseTokens: 32_768,
		tokenBudget: 1000,
		maxIterations: 5,
	})
	expect(
		resolveTurnGuards({ maxResponseTokens: 32_768 }, { maxResponseTokens: 65_536 }),
	).toHaveProperty('maxResponseTokens', 65_536)
	expect(resolveTurnGuards()).not.toHaveProperty('maxResponseTokens')
})

it.each([0, -1, 1.5, null, '32768', Number.MAX_SAFE_INTEGER + 1])(
	'refuses an invalid per-call output allowance: %j',
	(value) => {
		expect(() => loadConfig(fixture({ maxResponseTokens: value }))).toThrow(
			'limits.maxResponseTokens',
		)
		expect(() => resolveTurnGuards({ maxResponseTokens: value as number })).toThrow(
			'maxResponseTokens',
		)
	},
)

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

it('accepts a spend limit in dollars, and zero removes an inherited one', () => {
	expect(loadConfig(fixture({ costLimitUsd: 2.5 })).limits).toMatchObject({ costLimitUsd: 2.5 })
	expect(loadConfig(fixture({ costLimitUsd: 0 })).limits).toMatchObject({ costLimitUsd: 0 })
})

it.each([-1, null, 'cheap', Number.POSITIVE_INFINITY])(
	'rejects an invalid spend limit: %j',
	(value) => {
		expect(() => loadConfig(fixture({ costLimitUsd: value }))).toThrow('limits.costLimitUsd')
	},
)

it('lets a later layer set, change or lift the spend limit a turn runs under', () => {
	expect(resolveTurnGuards({ costLimitUsd: 2 }).costLimitUsd).toBe(2)
	expect(resolveTurnGuards({ costLimitUsd: 2 }, { costLimitUsd: 0.5 }).costLimitUsd).toBe(0.5)
	expect(resolveTurnGuards({ costLimitUsd: 2 }, { costLimitUsd: 0 })).not.toHaveProperty(
		'costLimitUsd',
	)
	expect(resolveTurnGuards({ tokenBudget: 10 })).not.toHaveProperty('costLimitUsd')
	expect(() => resolveTurnGuards({ costLimitUsd: -1 })).toThrow('costLimitUsd')
})
