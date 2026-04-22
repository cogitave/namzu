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
 *   - `searchDeferred(q)` is a case-insensitive filter against name OR
 *     description of every DEFERRED tool.
 *   - `assignTiers(mapping)` mutates `tool.tier` on existing tools;
 *     throws via `getOrThrow` on unknown name; throws if the tier id
 *     is not in `tierConfig.tiers`.
 *   - `toTierGuidance` returns null without a guidanceTemplate; calls
 *     the template with every defined tier otherwise.
 *   - `toPromptSection`: returns '' when no active or deferred tools;
 *     otherwise produces `<available_tools>` + `<deferred_tools>`
 *     fragments.
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
		expect(s).toContain('<available_tools>')
		expect(s).toContain('- a: a tool')
		expect(s).toContain('<deferred_tools>')
		expect(s).toContain('- b')
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
		expect(result.error).toMatch(/Invalid input/)
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

	it('returns the tool result on happy path', async () => {
		const r = new ToolRegistry()
		r.register(makeTool('good'))
		const result = await r.execute('good', {}, makeContext())
		expect(result.success).toBe(true)
		expect(result.output).toBe('good-ran')
	})
})
