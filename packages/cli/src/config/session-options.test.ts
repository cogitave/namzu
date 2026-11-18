import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { NamzuCliConfig } from './schema.js'
import {
	SESSION_KEY_MAP,
	advertisedPromptModes,
	sessionOptionsFromConfig,
	turnOptionsFromConfig,
} from './session-options.js'

const here = import.meta.dirname
const read = (relative: string): string => readFileSync(join(here, relative), 'utf8')

/** The top-level keys of `NamzuCliConfig`, read from the schema source so a new one cannot hide. */
function schemaKeys(): string[] {
	const lines = read('schema.ts').split('\n')
	const start = lines.findIndex((line) => line.startsWith('export interface NamzuCliConfig {'))
	const keys: string[] = []
	for (const line of lines.slice(start + 1)) {
		if (line.startsWith('}')) break
		const match = /^\treadonly ([A-Za-z]+)\??:/.exec(line)
		if (match?.[1]) keys.push(match[1])
	}
	return keys
}

/** Every session-affecting key set to a value that is not its default. */
const FULL = {
	learningObservations: false,
	permissionSettings: { disableAutoMode: true },
	mcpServers: { local: { command: 'x' } },
	plugins: { allow: ['p'] },
	skills: { builtin: false },
	web: { enabled: true },
	smallModel: 'small',
	hooks: { turn_end: [] },
	disableHooks: true,
	compaction: { clearStaleResultsAfterIdle: false },
	memory: { recall: false },
	limits: {
		maxResponseTokens: 512,
		maxReasoningTokens: 2000,
		doneGate: false,
		maxHookRefusals: 2,
		tokenBudget: 100,
		costLimitUsd: 0.5,
	},
	workflow: { maxAgents: 2 },
	handBack: { enabled: true },
	effort: 'low',
	closingSummary: false,
	outputStyle: 'plain sentences',
	attribution: 'Signed-off-by: A Person',
	sandbox: { enabled: true },
	decision: { enabled: true },
	codeAnalysis: { enabled: true },
	additionalDirectories: ['extra'],
	toolResultScreens: [],
} as unknown as NamzuCliConfig

describe('every configuration key reaches a session, or says why not', () => {
	it('names every key of the schema, and only those', () => {
		expect(Object.keys(SESSION_KEY_MAP).sort()).toEqual(schemaKeys().sort())
	})

	it('maps each key to an option the builder produces, or excludes it with a reason', () => {
		const built = Object.keys(sessionOptionsFromConfig(FULL, { cwd: '/work' }))
		for (const [key, target] of Object.entries(SESSION_KEY_MAP)) {
			if (target.startsWith('excluded: ')) {
				expect(target.length, `${key} needs a reason`).toBeGreaterThan('excluded: '.length + 10)
			} else {
				expect(built, `${key} maps to ${target}, which the builder did not produce`).toContain(
					target,
				)
			}
		}
	})

	it('produces every mapped option for a configuration that sets them all', () => {
		const options = sessionOptionsFromConfig(FULL, { cwd: '/work' })
		const mapped = new Set(
			Object.values(SESSION_KEY_MAP).filter((target) => !target.startsWith('excluded: ')),
		)
		for (const target of mapped) expect(options).toHaveProperty(target)
		expect(options.limits).toMatchObject({
			maxResponseTokens: 512,
			costLimitUsd: 0.5,
			doneGate: false,
		})
		expect(options.hooksSwitch).toBe('disabled')
		expect(options.handBack).toBe(true)
		expect(options.additionalDirectories).toEqual(['/work/extra'])
	})

	it('hands a turn the keys that are decided per turn', () => {
		expect(turnOptionsFromConfig({ hypermode: true, refusalFallback: 'off' })).toEqual({
			hypermode: true,
			refusalFallback: 'off',
		})
		expect(turnOptionsFromConfig({})).toEqual({})
		expect(turnOptionsFromConfig({ hypermode: false })).toEqual({})
	})
})

describe('flag precedence', () => {
	it('lets a flag beat the same limit in the file and leaves the others', () => {
		const options = sessionOptionsFromConfig(FULL, {
			cwd: '/work',
			limitsFromFlags: { maxResponseTokens: 900 },
		})
		expect(options.limits).toMatchObject({
			maxResponseTokens: 900,
			tokenBudget: 100,
		})
	})

	it('turns hand-back on from the flag alone, and prefers the resolved tool servers', () => {
		const options = sessionOptionsFromConfig(
			{
				handBack: { enabled: false },
				mcpServers: { a: { command: 'a' } },
			} as never,
			{
				cwd: '/work',
				handBackFlag: true,
				mcpServers: { b: { command: 'b' } } as never,
			},
		)
		expect(options.handBack).toBe(true)
		expect(options.mcpServers).toEqual({ b: { command: 'b' } })
	})

	it('keeps an empty screens list, which is the operator turning the default off', () => {
		expect(sessionOptionsFromConfig({ toolResultScreens: [] }, { cwd: '/w' })).toHaveProperty(
			'toolResultScreens',
			[],
		)
		expect(sessionOptionsFromConfig({}, { cwd: '/w' })).not.toHaveProperty('toolResultScreens')
	})

	it('builds nothing but the learning default for an empty configuration', () => {
		expect(sessionOptionsFromConfig({}, { cwd: '/w' })).toEqual({
			learningObservations: true,
		})
	})
})

describe('the hosts read the configuration through the one builder', () => {
	const mapped = Object.entries(SESSION_KEY_MAP)
		.filter(([, target]) => !target.startsWith('excluded: '))
		.map(([key]) => key)
		// `hypermode` and `refusalFallback` are per-turn and read by name in the hosts' turn options.
		.filter((key) => key !== 'hypermode' && key !== 'refusalFallback')
	for (const file of ['../commands/exec.ts', '../commands/exec-json.ts', '../commands/acp.ts']) {
		it(`${file} calls it and reads no mapped key itself`, () => {
			const source = read(file)
			expect(source).toContain('sessionOptionsFromConfig(')
			for (const key of mapped) {
				// `{ key: ctx.config.key }` is a session option passed on by hand, which is what
				// this forbids. Reading a key to decide something else (a message, a gate) is fine,
				// and so is the ACP host's own `permissionSettings` field on its record, which
				// `assertModeAllowed` reads and which is not a session option.
				if (file.endsWith('acp.ts') && key === 'permissionSettings') continue
				// `exec` reads `skills` again, apart from the session, to expand a `/skill` command.
				if (!file.endsWith('acp.ts') && key === 'skills') continue
				const byHand = new RegExp(`\\{\\s*${key}:\\s*(?:ctx|projectCtx)\\.config\\.${key}\\b`)
				expect(
					source.split('\n').filter((line) => byHand.test(line)),
					`${file} passes ${key} by hand`,
				).toEqual([])
			}
		})
	}
})

describe('the prompt modes a host advertises', () => {
	const safe = { root: false, sandboxed: false } as never
	it('offers both unless the settings close one', () => {
		expect(advertisedPromptModes({}, safe)).toEqual(['bypass', 'classify'])
		expect(advertisedPromptModes({ permissionSettings: { disableAutoMode: true } }, safe)).toEqual([
			'bypass',
		])
		expect(
			advertisedPromptModes({ permissionSettings: { disableBypassMode: true } }, safe),
		).toEqual(['classify'])
		expect(
			advertisedPromptModes(
				{
					permissionSettings: {
						disableAutoMode: true,
						disableBypassMode: true,
					},
				},
				safe,
			),
		).toEqual([])
	})
})
