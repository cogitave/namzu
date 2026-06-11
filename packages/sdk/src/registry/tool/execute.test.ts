/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 3):
 *
 *   - `ToolRegistry` extends `ManagedRegistry<ToolDefinition>` with
 *     `idField: 'name'` and an additional `availability` map keyed by
 *     tool name.
 *   - `register(tool)` defaults availability to 'active'; the array
 *     overload uses the second arg (if it's a string) as the initial
 *     state for all tools.
 *   - Tier validation: if `tool.tier` is set AND `tierConfig` is
 *     configured, the tier id must be in `tierConfig.tiers`; otherwise
 *     register throws. Tools without a tier (even with tierConfig
 *     configured) are always accepted.
 *   - `unregister` + `clear` drop both the Registry entry and the
 *     availability entry.
 *   - `activate` / `defer` take a list of names; each throws (via
 *     `getOrThrow`) if the name is unknown, then toggles availability.
 *   - `suspendAll` flips every `active` tool to `suspended`;
 *     `deferred` / `suspended` tools are left alone. `hasSuspended`
 *     reports true iff at least one tool is suspended.
 *   - `getAvailability(name)` returns 'active' as a default even for
 *     unknown names (this is non-obvious but is the current behavior).
 *   - `searchDeferred(q)` is a RANKED weighted search over DEFERRED tools:
 *     per meaningful term (≥3 chars, not a stop token) the score is
 *     exact-name 12 / name-substring 8 / description 5 / argument-name 3;
 *     results sort score-descending with name ties broken alphabetically.
 *     Generic/short tokens (`clawtool`, `tool`, CRUD verbs like `list`,
 *     `read`, …) are stopped so they can't over-activate the catalog.
 *   - `assignTiers(mapping)` mutates `tool.tier` on existing tools;
 *     throws via `getOrThrow` on unknown name; throws if the tier id
 *     is not in `tierConfig.tiers`.
 *   - `toTierGuidance` returns null without a guidanceTemplate; calls
 *     the template with every defined tier otherwise.
 *   - `toPromptSection`: returns '' when no active or deferred tools;
 *     otherwise produces `<available_tools>` (name-only — descriptions
 *     already ride the runtime tools param) + `<deferred_tools>` (name +
 *     first-sentence hint ≤100 chars) fragments.
 *   - `toLLMTools`: converts active + suspended tools (filtered by
 *     `toolNames` if provided) into LLM tool schemas via
 *     `zodToJsonSchema`. When `tierConfig.labelInDescription` is true,
 *     the description is prefixed with the tier label.
 *   - `execute`: validates availability → permissionMode plan gate →
 *     zod.safeParse → calls tool.execute inside an OTEL span; wraps
 *     thrown errors as `{success:false, error}`.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { RunId } from '../../types/ids/index.js'
import type { ToolContext, ToolDefinition, ToolTierConfig } from '../../types/tool/index.js'

import { ToolRegistry } from './execute.js'

function makeTool(name: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name,
		description: `${name} tool`,
		inputSchema: z.object({ k: z.string().optional() }),
		async execute() {
			return { success: true, output: `${name}-ran` }
		},
		...overrides,
	}
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		runId: 'run_1' as RunId,
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...overrides,
	}
}

describe('ToolRegistry — register + availability', () => {
	it('single-tool register: default availability is active', () => {
		const r = new ToolRegistry()
		r.register(makeTool('read'))
		expect(r.getAvailability('read')).toBe('active')
	})

	it('array-register: second arg sets availability for all', () => {
		const r = new ToolRegistry()
		r.register([makeTool('a'), makeTool('b')], 'deferred')
		expect(r.getAvailability('a')).toBe('deferred')
		expect(r.getAvailability('b')).toBe('deferred')
	})

	it('register overloads: array w/o state defaults active, (id, tool) form, bad id throws', () => {
		const r = new ToolRegistry()
		r.register([makeTool('arr')])
		expect(r.getAvailability('arr')).toBe('active')
		r.register('byid', makeTool('byid'))
		expect(r.get('byid')).toBeDefined()
		expect(() => r.register('oops', 'not-a-tool' as never)).toThrow(/requires a ToolDefinition/)
	})

	it('getAvailability returns active for unknown names (current default)', () => {
		const r = new ToolRegistry()
		expect(r.getAvailability('never-registered')).toBe('active')
	})

	it('unregister drops both the tool + the availability entry', () => {
		const r = new ToolRegistry()
		r.register(makeTool('a'))
		expect(r.unregister('a')).toBe(true)
		expect(r.get('a')).toBeUndefined()
		expect(r.listIds()).toEqual([])
	})

	it('clear empties both maps', () => {
		const r = new ToolRegistry()
		r.register(makeTool('a'))
		r.clear()
		expect(r.listIds()).toEqual([])
	})
})

describe('ToolRegistry — tier validation', () => {
	const tierConfig: ToolTierConfig = {
		tiers: [
			{ id: 'safe', label: 'Safe', priority: 1 },
			{ id: 'danger', label: 'Danger', priority: 10 },
		],
	}

	it('accepts tools without a tier even when tierConfig is configured', () => {
		const r = new ToolRegistry({ tierConfig })
		expect(() => r.register(makeTool('a'))).not.toThrow()
	})

	it('accepts tools whose tier is in the config', () => {
		const r = new ToolRegistry({ tierConfig })
		expect(() => r.register(makeTool('a', { tier: 'safe' }))).not.toThrow()
	})

	it('throws when tier id is unknown', () => {
		const r = new ToolRegistry({ tierConfig })
		expect(() => r.register(makeTool('a', { tier: 'bogus' }))).toThrow(/not defined/)
	})
})

describe('ToolRegistry — activate / defer / suspend', () => {
	it('activate + defer throw via getOrThrow on unknown name', () => {
		const r = new ToolRegistry()
		expect(() => r.activate(['unknown'])).toThrow(/Not found/)
		expect(() => r.defer(['unknown'])).toThrow(/Not found/)
	})

	it('activate sets state to active', () => {
		const r = new ToolRegistry()
		r.register([makeTool('a')], 'deferred')
		r.activate(['a'])
		expect(r.getAvailability('a')).toBe('active')
	})

	it('defer sets state to deferred', () => {
		const r = new ToolRegistry()
		r.register(makeTool('a'))
		r.defer(['a'])
		expect(r.getAvailability('a')).toBe('deferred')
	})

	it('suspendAll flips active → suspended; leaves deferred / suspended alone', () => {
		const r = new ToolRegistry()
		r.register(makeTool('a'))
		r.register(makeTool('b'))
		r.register([makeTool('c')], 'deferred')
		r.suspendAll()
		expect(r.getAvailability('a')).toBe('suspended')
		expect(r.getAvailability('b')).toBe('suspended')
		expect(r.getAvailability('c')).toBe('deferred')
		expect(r.hasSuspended()).toBe(true)
	})

	it('hasSuspended returns false when none are suspended', () => {
		const r = new ToolRegistry()
		r.register(makeTool('a'))
		expect(r.hasSuspended()).toBe(false)
	})
})

describe('ToolRegistry — searchDeferred', () => {
	it('filters only deferred tools by name OR description (case-insensitive)', () => {
		const r = new ToolRegistry()
		r.register([makeTool('alpha', { description: 'does alpha' })], 'deferred')
		r.register([makeTool('beta', { description: 'does BETA' })], 'deferred')
		r.register(makeTool('gamma'))
		expect(r.searchDeferred('alpha').map((t) => t.name)).toEqual(['alpha'])
		expect(r.searchDeferred('beta').map((t) => t.name)).toEqual(['beta'])
		expect(r.searchDeferred('does').map((t) => t.name)).toEqual(['alpha', 'beta'])
		expect(r.searchDeferred('gamma')).toEqual([])
	})

	it('tokenizes a multi-term query so a batch of tool names each match', () => {
		const r = new ToolRegistry()
		r.register([makeTool('clawtool_A2aCard')], 'deferred')
		r.register([makeTool('clawtool_PeerRegister')], 'deferred')
		r.register([makeTool('clawtool_PeerList')], 'deferred')
		r.register([makeTool('clawtool_Unrelated')], 'deferred')
		// A whole-phrase substring match would find none of these. Equal
		// scores tie-break alphabetically by name (deterministic ranking).
		expect(r.searchDeferred('A2aCard PeerRegister PeerList').map((t) => t.name)).toEqual([
			'clawtool_A2aCard',
			'clawtool_PeerList',
			'clawtool_PeerRegister',
		])
		expect(r.searchDeferred('   ')).toEqual([])
	})

	it('ranks exact name above name substring above description-only matches', () => {
		const r = new ToolRegistry()
		r.register([makeTool('release_notes', { description: 'Write deploy notes.' })], 'deferred')
		r.register([makeTool('deploy_preview', { description: 'Stage a preview build.' })], 'deferred')
		r.register([makeTool('deploy', { description: 'Ship the current build.' })], 'deferred')
		expect(r.searchDeferred('deploy').map((t) => t.name)).toEqual([
			'deploy', // exact name → 12
			'deploy_preview', // name substring → 8
			'release_notes', // description only → 5
		])
	})

	it('indexes argument names so a parameter term can locate a tool', () => {
		const r = new ToolRegistry()
		r.register(
			[
				makeTool('send_invoice', {
					inputSchema: z.object({ customerEmail: z.string(), amount: z.number() }),
				}),
			],
			'deferred',
		)
		r.register([makeTool('send_reminder')], 'deferred')
		expect(r.searchDeferred('customerEmail').map((t) => t.name)).toEqual(['send_invoice'])
	})

	it('stops generic CRUD verbs so they cannot activate catalog slices', () => {
		const r = new ToolRegistry()
		r.register(
			[makeTool('list_deals', { description: 'List the deals in an account.' })],
			'deferred',
		)
		r.register([makeTool('list_workflows', { description: 'List workflows.' })], 'deferred')
		r.register([makeTool('read_document', { description: 'Read a document body.' })], 'deferred')
		// Bare CRUD verbs identify nothing.
		expect(r.searchDeferred('list')).toEqual([])
		expect(r.searchDeferred('read')).toEqual([])
		expect(r.searchDeferred('create update delete')).toEqual([])
		// The non-generic remainder carries the query.
		expect(r.searchDeferred('list deals').map((t) => t.name)).toEqual(['list_deals'])
		expect(r.searchDeferred('read document').map((t) => t.name)).toEqual(['read_document'])
	})

	it('does not over-activate on generic/shared tokens', () => {
		const r = new ToolRegistry()
		r.register([makeTool('clawtool_A2aCard', { description: 'peer card' })], 'deferred')
		r.register([makeTool('clawtool_PeerList', { description: 'list peers' })], 'deferred')
		r.register([makeTool('clawtool_WebSearch', { description: 'search the web' })], 'deferred')
		// The shared "clawtool" prefix token must not drag in every tool.
		expect(r.searchDeferred('clawtool WebSearch').map((t) => t.name)).toEqual([
			'clawtool_WebSearch',
		])
		// A bare generic token identifies nothing — must not activate the catalog.
		expect(r.searchDeferred('clawtool')).toEqual([])
		expect(r.searchDeferred('tool')).toEqual([])
	})
})

describe('ToolRegistry — tier mutation + guidance', () => {
	const tierConfig: ToolTierConfig = {
		tiers: [
			{ id: 'safe', label: 'Safe', priority: 1 },
			{ id: 'danger', label: 'Danger', priority: 10 },
		],
		guidanceTemplate: (tiers) => `tiers: ${tiers.map((t) => t.id).join(',')}`,
		labelInDescription: true,
	}

	it('assignTiers sets the tier on each mapped tool', () => {
		const r = new ToolRegistry({ tierConfig })
		r.register(makeTool('a'))
		r.assignTiers({ a: 'safe' })
		expect(r.get('a')?.tier).toBe('safe')
	})

	it('assignTiers throws when the tier is unknown', () => {
		const r = new ToolRegistry({ tierConfig })
		r.register(makeTool('a'))
		expect(() => r.assignTiers({ a: 'bogus' })).toThrow(/not defined/)
	})

	it('toTierGuidance returns null without a template', () => {
		const r = new ToolRegistry()
		expect(r.toTierGuidance()).toBeNull()
	})

	it('toTierGuidance renders via the template', () => {
		const r = new ToolRegistry({ tierConfig })
		expect(r.toTierGuidance()).toBe('tiers: safe,danger')
	})
})

describe('ToolRegistry — toPromptSection + toLLMTools', () => {
	it('toPromptSection returns empty when the registry is empty', () => {
		const r = new ToolRegistry()
		expect(r.toPromptSection()).toBe('')
	})

	it('toPromptSection renders available + deferred fragments', () => {
		const r = new ToolRegistry()
		r.register(makeTool('a'))
		r.register([makeTool('b')], 'deferred')
		const s = r.toPromptSection()
		expect(s).toContain('<tool_runtime_contract>')
		expect(s).toContain('runtime tools parameter')
		expect(s).toContain('<available_tools>')
		// Active entries are NAME-ONLY: the description already rides the
		// runtime tools param every request — repeating it double-bills.
		expect(s).toContain('- a\n')
		expect(s).not.toContain('- a: a tool')
		expect(s).toContain('<deferred_tools>')
		expect(s).toContain('Deferred tools are discoverable')
		// Deferred entries carry a one-line hint — their schema is off the
		// wire, so the hint is the model's only capability signal.
		expect(s).toContain('- b: b tool')
	})

	it('toPromptSection truncates deferred hints to the first sentence, capped at 100 chars', () => {
		const r = new ToolRegistry()
		r.register(
			[
				makeTool('two_sentences', {
					description: 'Reads the document. Second sentence that must not appear.',
				}),
				makeTool('long_sentence', {
					description: `${'x'.repeat(150)} end`,
				}),
			],
			'deferred',
		)
		const s = r.toPromptSection()
		expect(s).toContain('- two_sentences: Reads the document.')
		expect(s).not.toContain('Second sentence')
		const longLine = s.split('\n').find((line) => line.startsWith('- long_sentence:'))
		expect(longLine).toBeDefined()
		const hint = (longLine ?? '').replace('- long_sentence: ', '')
		expect(hint.length).toBeLessThanOrEqual(100)
		expect(hint.endsWith('…')).toBe(true)
	})

	it('toPromptSection references search_tools only when it is active', () => {
		const r = new ToolRegistry()
		r.register(makeTool('search_tools'))
		r.register([makeTool('b')], 'deferred')
		const s = r.toPromptSection()
		expect(s).toContain('Use search_tools to load these before use')
	})

	it('toLLMTools: converts active + suspended tools', () => {
		const r = new ToolRegistry()
		r.register(makeTool('a'))
		r.register([makeTool('b')], 'deferred')
		r.register([makeTool('c')], 'suspended')

		const schemas = r.toLLMTools()
		const names = schemas.map((t) => t.function.name).sort()
		expect(names).toEqual(['a', 'c'])
	})

	it('toLLMTools: prefixes description with tier label when labelInDescription is true', () => {
		const tierConfig: ToolTierConfig = {
			tiers: [{ id: 'safe', label: 'Safe', priority: 1 }],
			labelInDescription: true,
		}
		const r = new ToolRegistry({ tierConfig })
		r.register(makeTool('a', { tier: 'safe' }))
		const schemas = r.toLLMTools()
		expect(schemas[0]?.function.description).toBe('[Safe] a tool')
	})
})

describe('ToolRegistry — execute', () => {
	it('returns error when tool is not active (e.g. deferred)', async () => {
		const r = new ToolRegistry()
		r.register([makeTool('a')], 'deferred')
		const result = await r.execute('a', {}, makeContext())
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/deferred and cannot be executed/)
	})

	it('blocks non-read-only tools in plan mode', async () => {
		const r = new ToolRegistry()
		r.register(makeTool('write', { isReadOnly: () => false }))
		const result = await r.execute(
			'write',
			{},
			makeContext({
				permissionContext: { mode: 'plan', runId: 'run_1', workingDirectory: '/tmp' },
			}),
		)
		expect(result.success).toBe(false)
		expect(result.permissionDenied).toBe(true)
	})

	it('allows read-only tools in plan mode', async () => {
		const r = new ToolRegistry()
		const execute = vi.fn(async () => ({ success: true, output: 'ok' }))
		r.register(makeTool('read', { isReadOnly: () => true, execute }))
		const result = await r.execute(
			'read',
			{},
			makeContext({
				permissionContext: { mode: 'plan', runId: 'run_1', workingDirectory: '/tmp' },
			}),
		)
		expect(result.success).toBe(true)
		expect(execute).toHaveBeenCalled()
	})

	it('returns error when input fails zod validation', async () => {
		const r = new ToolRegistry()
		r.register(
			makeTool('strict', {
				inputSchema: z.object({ required: z.string() }),
			}),
		)
		const result = await r.execute('strict', { required: 123 }, makeContext())
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/Validation failed for "strict"/)
		expect(result.error).toContain('Expected string, received number')
	})

	it('empty-args validation lists required params with descriptions', async () => {
		const r = new ToolRegistry()
		r.register(
			makeTool('needs', {
				inputSchema: z.object({ q: z.string().describe('the query'), n: z.number() }),
			}),
		)
		const result = await r.execute('needs', {}, makeContext())
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/called with no arguments/)
		expect(result.error).toContain('q: string — the query')
		expect(result.error).toContain('n: number')
	})

	it('validation hint reports when there are no required params', async () => {
		const r = new ToolRegistry()
		r.register(makeTool('opt', { inputSchema: z.object({ k: z.string().optional() }) }))
		const result = await r.execute('opt', { k: 123 }, makeContext())
		expect(result.success).toBe(false)
		expect(result.error).toContain('No required parameters known.')
	})

	it('validation hint tolerates a schema it cannot introspect', async () => {
		const r = new ToolRegistry()
		const bogusSchema = {
			safeParse: () => ({ success: false, error: { issues: [{ path: [], message: 'nope' }] } }),
		}
		r.register(makeTool('weird', { inputSchema: bogusSchema as never }))
		const result = await r.execute('weird', { a: 1 }, makeContext())
		expect(result.success).toBe(false)
		expect(result.error).toContain('Could not introspect required parameters.')
	})

	it('wraps thrown errors in the execute function', async () => {
		const r = new ToolRegistry()
		r.register(
			makeTool('bad', {
				async execute() {
					throw new Error('boom')
				},
			}),
		)
		const result = await r.execute('bad', {}, makeContext())
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/execution failed: boom/)
	})

	it('wraps a non-Error throw', async () => {
		const r = new ToolRegistry()
		r.register(
			makeTool('throws-string', {
				async execute() {
					throw 'plain string failure'
				},
			}),
		)
		const result = await r.execute('throws-string', {}, makeContext())
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/execution failed/)
	})

	it('passes through a tool result that is unsuccessful with an error', async () => {
		const r = new ToolRegistry()
		r.register(
			makeTool('soft-fail', {
				async execute() {
					return { success: false, output: '', error: 'soft failure' }
				},
			}),
		)
		const result = await r.execute('soft-fail', {}, makeContext())
		expect(result.success).toBe(false)
		expect(result.error).toBe('soft failure')
	})

	it('blocks a non-read-only tool in plan mode (no isReadOnly hint)', async () => {
		const r = new ToolRegistry()
		const execute = vi.fn(async () => ({ success: true, output: 'ok' }))
		r.register(makeTool('mutate', { execute }))
		const result = await r.execute(
			'mutate',
			{},
			makeContext({
				permissionContext: { mode: 'plan', runId: 'run_1', workingDirectory: '/tmp' },
			}),
		)
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/plan mode/)
		expect(execute).not.toHaveBeenCalled()
	})

	it('returns the tool result on happy path', async () => {
		const r = new ToolRegistry()
		r.register(makeTool('good'))
		const result = await r.execute('good', {}, makeContext())
		expect(result.success).toBe(true)
		expect(result.output).toBe('good-ran')
	})
})
