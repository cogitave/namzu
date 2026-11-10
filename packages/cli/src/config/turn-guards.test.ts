import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { loadConfig, takeConfigWarnings } from './load.js'
import { resolveTurnGuards, turnConfigFields } from './turn-guards.js'

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
	'refuses an invalid exported output size: %j',
	(value) => {
		expect(() => loadConfig({ ...fixture({}), env: { NAMZU_MAX_OUTPUT_TOKENS: value } })).toThrow(
			'NAMZU_MAX_OUTPUT_TOKENS',
		)
	},
)

it.each([
	['786k', 786_000],
	['200000', 200_000],
	['1m', 1_000_000],
	['300K', 300_000],
])('reads the exported compact window %j as %i', (value, tokens) => {
	takeConfigWarnings()
	const config = loadConfig({ ...fixture({}), env: { NAMZU_AUTO_COMPACT_WINDOW: value } })
	expect(config.compaction?.autoCompactWindowTokens).toBe(tokens)
	expect(takeConfigWarnings()).toEqual([])
})

it.each([
	['50000', 100_000, '100k minimum'],
	['5m', 1_000_000, '1M maximum'],
	['9007199254740992', 1_000_000, '1M maximum'],
])('clamps the exported compact window %j to %i with one warning', (value, tokens, wording) => {
	takeConfigWarnings()
	const config = loadConfig({ ...fixture({}), env: { NAMZU_AUTO_COMPACT_WINDOW: value } })
	expect(config.compaction?.autoCompactWindowTokens).toBe(tokens)
	const warnings = takeConfigWarnings()
	expect(warnings).toHaveLength(1)
	expect(warnings[0]).toContain('NAMZU_AUTO_COMPACT_WINDOW')
	expect(warnings[0]).toContain(wording)
})

it.each(['no', '0', '-1', ''])(
	'ignores an exported compact window that is no size: %j',
	(value) => {
		takeConfigWarnings()
		const config = loadConfig({ ...fixture({}), env: { NAMZU_AUTO_COMPACT_WINDOW: value } })
		expect(config.compaction?.autoCompactWindowTokens).toBeUndefined()
		expect(takeConfigWarnings().join('\n')).toContain('ignores it')
	},
)

it('reads and clamps the configured compact window the same way', () => {
	takeConfigWarnings()
	const options = fixture({})
	writeFileSync(
		join(options.cwd, 'namzu.config.json'),
		JSON.stringify({ compaction: { autoCompactWindowTokens: '786k' } }),
	)
	expect(loadConfig(options).compaction?.autoCompactWindowTokens).toBe(786_000)
	writeFileSync(
		join(options.cwd, 'namzu.config.json'),
		JSON.stringify({ compaction: { autoCompactWindowTokens: 2_000_000 } }),
	)
	expect(loadConfig(options).compaction?.autoCompactWindowTokens).toBe(1_000_000)
	expect(takeConfigWarnings().join('\n')).toContain('compaction.autoCompactWindowTokens')
})

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

it('carries the reasoning cap and the done-gate from the resolved limits into the turn', () => {
	const guards = resolveTurnGuards({ maxReasoningTokens: 9000 }, { doneGate: true })
	expect(turnConfigFields(guards, { completionAudit: true })).toMatchObject({
		reasoning: { maxTokens: 9000 },
		completionAudit: true,
	})
	// Delegated children are not audited, but they keep the cap.
	expect(turnConfigFields(guards)).toEqual(
		expect.not.objectContaining({ completionAudit: expect.anything() }),
	)
	expect(turnConfigFields(guards).reasoning).toEqual({ maxTokens: 9000 })
})

it('leaves both at the kernel default when nothing sets them, and lets a later layer lift the cap', () => {
	expect(turnConfigFields(resolveTurnGuards({}), { completionAudit: true })).toEqual({
		tokenBudget: 0,
		maxIterations: 0,
		timeoutMs: 0,
		completionAudit: true,
	})
	expect(
		turnConfigFields(resolveTurnGuards({ maxReasoningTokens: 9000 }, { maxReasoningTokens: 0 }))
			.reasoning,
	).toEqual({ maxTokens: 0 })
})

it('turns the done-gate off with doneGate: false, and refuses a bad cap', () => {
	const off = resolveTurnGuards({ doneGate: false })
	expect(turnConfigFields(off, { completionAudit: true }).completionAudit).toBeUndefined()
	expect(() => resolveTurnGuards({ maxReasoningTokens: -1 })).toThrow('maxReasoningTokens')
})

it('carries the hook refusal limit into the turn, and refuses a bad one', () => {
	expect(turnConfigFields(resolveTurnGuards({ maxHookRefusals: 3 })).maxHookRefusals).toBe(3)
	expect(
		turnConfigFields(resolveTurnGuards({ maxHookRefusals: 3 }, { maxHookRefusals: 0 })),
	).toMatchObject({
		maxHookRefusals: 0,
	})
	expect(turnConfigFields(resolveTurnGuards({}))).not.toHaveProperty('maxHookRefusals')
	expect(() => resolveTurnGuards({ maxHookRefusals: -1 })).toThrow('maxHookRefusals')
})
