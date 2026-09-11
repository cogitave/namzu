import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ToolResultGuardrailContext } from '../../../types/guardrail/index.js'
import type { ToolContext, ToolDefinition, ToolTierConfig } from '../../../types/tool/index.js'
import { ToolRegistry, type ToolRegistryForkOptions } from '../execute.js'

function tool(name: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name,
		description: `Inspect ${name}.`,
		inputSchema: z.object({ value: z.string().optional() }),
		execute: vi.fn(async () => ({ success: true, output: `${name} result` })),
		...overrides,
	}
}

function context(allowedTools?: readonly string[]): ToolContext {
	return {
		runId: 'a9ec0823-6aee-4a42-8ee9-b279763a694d' as ToolContext['runId'],
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...(allowedTools === undefined ? {} : { allowedTools }),
	}
}

describe('a run forks tool availability', () => {
	it('snapshots availability and isolates later source and sibling changes', () => {
		const source = new ToolRegistry()
		const read = tool('read')
		const lookup = tool('lookup')
		source.register(read)
		source.register(lookup, 'deferred')
		source.register(tool('suspended'), 'suspended')
		const first = source.fork()
		const second = source.fork()
		expect(first.listNames()).toEqual(source.listNames())
		expect(first.get('read')).toBe(read)
		expect(first.get('lookup')).toBe(lookup)
		expect(first.getAvailability('read')).toBe('active')
		expect(first.getAvailability('lookup')).toBe('deferred')
		expect(first.getAvailability('suspended')).toBe('suspended')

		first.activate(['lookup'])
		first.defer(['read'])
		second.suspendAll()
		expect(first.getCallableTools().map((item) => item.name)).toEqual(['lookup'])
		expect(second.getCallableTools()).toEqual([])
		expect(second.getAvailability('lookup')).toBe('deferred')
		expect(source.getCallableTools().map((item) => item.name)).toEqual(['read'])
		source.activate(['lookup'])
		expect(second.getAvailability('lookup')).toBe('deferred')
		source.unregister('read')
		expect(first.get('read')).toBe(read)
		expect(second.get('read')).toBe(read)
		first.clear()
		expect(second.listNames()).toEqual(['read', 'lookup', 'suspended'])
		expect(source.listNames()).toEqual(['lookup', 'suspended'])
	})

	it('defers active tools outside an exact roster without reviving unavailable tools', async () => {
		const source = new ToolRegistry()
		const suspended = tool('suspended')
		source.register([tool('read'), tool('edit')])
		source.register(tool('lookup'), 'deferred')
		source.register(suspended, 'suspended')
		const options: ToolRegistryForkOptions = {
			deferExcept: ['read', 'lookup', 'suspended'],
		}
		const fork = source.fork(options)
		expect(fork.getCallableTools().map((item) => item.name)).toEqual(['read'])
		expect(fork.getAvailability('edit')).toBe('deferred')
		expect(fork.getAvailability('lookup')).toBe('deferred')
		expect(fork.getAvailability('suspended')).toBe('suspended')
		expect(fork.searchDeferred('suspended')).toEqual([])
		expect(await fork.execute('suspended', {}, context())).toMatchObject({ success: false })
		expect(suspended.execute).not.toHaveBeenCalled()
		expect(source.getAvailability('edit')).toBe('active')

		const allDeferred = source.fork({ deferExcept: [] })
		expect(allDeferred.getCallableTools()).toEqual([])
		expect(allDeferred.getAvailability('suspended')).toBe('suspended')
		expect(allDeferred.getAvailability('read')).toBe('deferred')
	})

	it('keeps ordinary runtime registration and replacement local to the fork', async () => {
		const source = new ToolRegistry()
		const host = tool('host')
		source.register(host)
		const fork = source.fork()
		const sibling = source.fork()
		const runtimeTool = tool('task_create')
		fork.register(runtimeTool, 'deferred')
		const replacement = tool('host', {
			execute: vi.fn(async () => ({ success: true, output: 'replacement' })),
		})
		// Forks preserve normal register/overwrite semantics; they introduce no
		// separate ownership grant or collision exception for runtime tools.
		fork.register(replacement)
		expect(fork.get('task_create')).toBe(runtimeTool)
		expect(source.has('task_create')).toBe(false)
		expect(sibling.has('task_create')).toBe(false)
		expect(source.get('host')).toBe(host)
		expect(sibling.get('host')).toBe(host)
		expect(await fork.execute('host', {}, context())).toMatchObject({ output: 'replacement' })
		expect(host.execute).not.toHaveBeenCalled()
	})

	it('preserves schema metadata, handlers, tiers and provenance-aware result screening', async () => {
		const screen = vi.fn((ctx: ToolResultGuardrailContext) => ({
			action: 'refuse' as const,
			reason: `Review ${ctx.toolName} before using its output`,
		}))
		const tiers: ToolTierConfig = {
			tiers: [{ id: 'read', label: 'Read only', priority: 1 }],
			labelInDescription: true,
			guidanceTemplate: (values) => values.map((tier) => tier.label).join(', '),
		}
		const source = new ToolRegistry({ tierConfig: tiers, resultGuardrails: [screen] })
		const modelInputSchema = {
			type: 'object',
			properties: { value: { type: 'string' } },
			required: ['value'],
			additionalProperties: false,
		}
		const lookup = tool('lookup', {
			tier: 'read',
			modelInputSchema,
			enforceModelInput: true,
			outputSchema: { type: 'string' },
			provenance: { server: 'fixture', readOnlyHintTrusted: false },
		})
		source.register(lookup)
		const fork = source.fork({ deferExcept: [] })
		expect(fork.get('lookup')).toBe(lookup)
		expect(fork.toLLMTools()).toEqual([])
		fork.activate(['lookup'])
		expect(fork.toLLMTools()).toEqual(source.toLLMTools())
		expect(fork.toLLMTools()[0]?.function).toMatchObject({ parameters: modelInputSchema })
		expect(fork.toLLMTools()[0]?.function.description).toContain('[Read only]')
		expect(fork.toLLMTools()[0]?.function.description).toContain('Returns (JSON Schema)')
		expect(fork.toTierGuidance()).toBe('Read only')
		expect(await fork.execute('lookup', { value: 'private' }, context([]))).toMatchObject({
			permissionDenied: true,
		})
		expect(lookup.execute).not.toHaveBeenCalled()
		expect(await fork.execute('lookup', { value: 'private' }, context(['lookup']))).toMatchObject({
			success: false,
			error: expect.stringContaining('Review lookup'),
		})
		expect(lookup.execute).toHaveBeenCalledTimes(1)
		expect(screen).toHaveBeenCalledTimes(1)
		expect(screen.mock.calls[0]?.[0]).toMatchObject({
			toolName: 'lookup',
			input: { value: 'private' },
			provenance: lookup.provenance,
		})
	})

	it('does not transfer prepared execution authority even when the handler is shared', async () => {
		const source = new ToolRegistry()
		const read = tool('read')
		source.register(read)
		const prepared = source.prepareExecution('read', { value: 'original' })
		if (!prepared.success) throw new Error('Fixture preparation failed')
		const fork = source.fork()
		expect(await fork.executePrepared(prepared.prepared, context())).toMatchObject({
			success: false,
			error: expect.stringContaining('not owned by this registry'),
		})
		expect(read.execute).not.toHaveBeenCalled()
		expect(await source.executePrepared(prepared.prepared, context())).toMatchObject({
			success: true,
		})
		expect(read.execute).toHaveBeenCalledTimes(1)
	})

	it.each([
		{ deferExcept: 'read' },
		{ deferExcept: [''] },
		{ deferExcept: [' read'] },
		{ deferExcept: [42] },
		{ deferExcept: ['read', 'read'] },
		{ deferExcept: ['read', 'missing'] },
	])('refuses an invalid roster without changing the source: %j', (options) => {
		const source = new ToolRegistry()
		source.register(tool('read'))
		expect(() => source.fork(options as ToolRegistryForkOptions)).toThrow()
		expect(source.listNames()).toEqual(['read'])
		expect(source.getAvailability('read')).toBe('active')
	})
})
