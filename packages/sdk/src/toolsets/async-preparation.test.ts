import { getEventListeners } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { fixtureId } from '../test-support/ids.js'
import { testToolset } from '../test-support/toolset.js'
import type { ToolContext, ToolDefinition } from '../types/tool/index.js'
import { liveToolset, tool } from './__fixtures__/toolsets.js'
import { ToolManager } from './manager.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((ok, fail) => {
		resolve = ok
		reject = fail
	})
	return { promise, resolve, reject }
}

function context(signal = new AbortController().signal): ToolContext {
	return {
		sessionId: fixtureId.session('async-preparation'),
		turnId: fixtureId.turn('async-preparation'),
		workingDirectory: '/tmp',
		abortSignal: signal,
		env: {},
		log: () => {},
	}
}

function manager(
	schema: z.ZodType,
	execute = vi.fn(async (_input: unknown) => ({ success: true, output: 'ran' })),
) {
	const definition = tool('prepared', { inputSchema: schema, execute })
	return {
		manager: new ToolManager({ toolsets: [testToolset(definition)], messages: () => [] }),
		execute,
	}
}

describe('asynchronous tool preparation', () => {
	it('refines and transforms once, then executes a separate frozen review projection', async () => {
		const refine = vi.fn(async () => {})
		const transform = vi.fn(async ({ value }: { value: string }) => ({
			nested: { value: `${value}-normalized` },
		}))
		const schema = z.object({ value: z.string() }).superRefine(refine).transform(transform)
		const f = manager(schema)
		const result = await f.manager.prepareExecutionAsync('prepared', { value: 'original' })
		expect(result.success).toBe(true)
		if (!result.success) throw new Error('expected preparation')
		expect(result.prepared.input).toEqual({ nested: { value: 'original-normalized' } })
		expect(Object.isFrozen(result.prepared)).toBe(true)
		expect(Object.isFrozen(result.prepared.input)).toBe(true)
		expect(Object.isFrozen((result.prepared.input as { nested: unknown }).nested)).toBe(true)
		expect(await f.manager.executePrepared(result.prepared, context())).toMatchObject({
			success: true,
		})
		expect(refine).toHaveBeenCalledOnce()
		expect(transform).toHaveBeenCalledOnce()
		expect(f.execute).toHaveBeenCalledExactlyOnceWith(
			{ nested: { value: 'original-normalized' } },
			expect.anything(),
		)
		expect(f.execute.mock.calls[0]?.[0]).not.toBe(result.prepared.input)
	})

	it('detaches JSON input before an asynchronous preprocess can inspect caller mutations', async () => {
		const entered = deferred<void>()
		const release = deferred<void>()
		const f = manager(
			z.preprocess(
				async (input) => {
					entered.resolve()
					await release.promise
					return input
				},
				z.object({ nested: z.object({ command: z.string() }) }),
			),
		)
		const callerOwned = { nested: { command: 'status' } }
		const pending = f.manager.prepareExecutionAsync('prepared', callerOwned)
		await entered.promise
		callerOwned.nested.command = 'git push origin main'
		release.resolve()
		const result = await pending
		if (!result.success) throw new Error('expected preparation')
		expect(result.prepared.input).toEqual({ nested: { command: 'status' } })
		await f.manager.executePrepared(result.prepared, context())
		expect(f.execute.mock.calls[0]?.[0]).toEqual({ nested: { command: 'status' } })
	})

	it('uses asynchronous preparation in execute without a second parse', async () => {
		const transform = vi.fn(async ({ value }: { value: number }) => ({ value: value + 1 }))
		const f = manager(z.object({ value: z.number() }).transform(transform))
		expect(await f.manager.execute('prepared', { value: 1 }, context())).toMatchObject({
			success: true,
		})
		expect(transform).toHaveBeenCalledOnce()
		expect(f.execute.mock.calls[0]?.[0]).toEqual({ value: 2 })
	})

	it('keeps execution compatible with a host context that omits its cancellation signal', async () => {
		const transform = vi.fn(async ({ value }: { value: number }) => ({ value: value + 1 }))
		const f = manager(z.object({ value: z.number() }).transform(transform))
		const hostContext = context()
		Reflect.deleteProperty(hostContext, 'abortSignal')
		expect(await f.manager.execute('prepared', { value: 1 }, hostContext)).toMatchObject({
			success: true,
		})
		expect(transform).toHaveBeenCalledOnce()
		expect(f.execute.mock.calls[0]?.[0]).toEqual({ value: 2 })
	})

	it('does not start validation when preparation or execute is already cancelled', async () => {
		const controller = new AbortController()
		const reason = new Error('cancelled before validation')
		controller.abort(reason)
		const refine = vi.fn(async () => {})
		const f = manager(z.object({}).superRefine(refine))
		await expect(f.manager.prepareExecutionAsync('prepared', {}, controller.signal)).rejects.toBe(
			reason,
		)
		await expect(f.manager.execute('prepared', {}, context(controller.signal))).rejects.toBe(reason)
		expect(refine).not.toHaveBeenCalled()
		expect(f.execute).not.toHaveBeenCalled()
		expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
	})

	it('stops waiting during validation and leaves a late successful parse unpublished', async () => {
		const controller = new AbortController()
		const entered = deferred<void>()
		const release = deferred<void>()
		const finished = deferred<void>()
		const f = manager(
			z.object({}).transform(async () => {
				entered.resolve()
				await release.promise
				finished.resolve()
				return { value: 'late' }
			}),
		)
		const executePrepared = vi.spyOn(f.manager, 'executePrepared')
		const pending = f.manager.execute('prepared', {}, context(controller.signal))
		await entered.promise
		const reason = new Error('cancelled while validating')
		controller.abort(reason)
		await expect(pending).rejects.toBe(reason)
		expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
		release.resolve()
		await finished.promise
		expect(executePrepared).not.toHaveBeenCalled()
		expect(f.execute).not.toHaveBeenCalled()
	})

	it('keeps a schema rejection observed after cancellation wins', async () => {
		const controller = new AbortController()
		const entered = deferred<void>()
		const operation = deferred<unknown>()
		const f = manager(
			z.object({}).transform(async () => {
				entered.resolve()
				return operation.promise
			}),
		)
		const pending = f.manager.prepareExecutionAsync('prepared', {}, controller.signal)
		await entered.promise
		const reason = new Error('stop waiting')
		controller.abort(reason)
		await expect(pending).rejects.toBe(reason)
		operation.reject(new Error('late schema failure'))
		// Vitest reports any unhandled rejection; observe settlement deterministically.
		await expect(operation.promise).rejects.toThrow('late schema failure')
		expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
		expect(f.execute).not.toHaveBeenCalled()
	})

	it('checks cancellation after a parse succeeds and before its preparation is published', async () => {
		const controller = new AbortController()
		const reason = new Error('cancelled at parse settlement')
		const parseResult = Promise.resolve({ success: true as const, data: { value: 'accepted' } })
		const schema = z.object({ value: z.string() })
		vi.spyOn(schema, 'safeParseAsync').mockImplementation(() => {
			// Registered before the waiter's continuation: accepted parsing alone
			// must not grant publication once authority is withdrawn.
			void parseResult.then(() => controller.abort(reason))
			return parseResult
		})
		const f = manager(schema)
		await expect(f.manager.prepareExecutionAsync('prepared', {}, controller.signal)).rejects.toBe(
			reason,
		)
		expect(f.execute).not.toHaveBeenCalled()
	})

	it('does not execute when authority is withdrawn after preparation publication', async () => {
		const controller = new AbortController()
		const reason = new Error('cancelled before execution')
		const f = manager(z.object({}))
		const prepare = f.manager.prepareExecutionAsync.bind(f.manager)
		vi.spyOn(f.manager, 'prepareExecutionAsync').mockImplementation((name, input, signal) => {
			const pending = prepare(name, input, signal)
			void pending.then(() => controller.abort(reason))
			return pending
		})
		await expect(f.manager.execute('prepared', {}, context(controller.signal))).rejects.toBe(reason)
		expect(f.execute).not.toHaveBeenCalled()
	})

	it('refuses execution if its tool was removed while asynchronous validation was pending', async () => {
		const entered = deferred<void>()
		const release = deferred<void>()
		const execute = vi.fn(async () => ({ success: true, output: 'ran' }))
		const definition = tool('prepared', {
			inputSchema: z.object({}).superRefine(async () => {
				entered.resolve()
				await release.promise
			}),
			execute,
		})
		const live = liveToolset('live', [definition])
		const m = new ToolManager({ toolsets: [live.toolset], messages: () => [] })
		const pending = m.prepareExecutionAsync('prepared', {})
		await entered.promise
		live.setTools([])
		m.refresh()
		release.resolve()
		const result = await pending
		if (!result.success) throw new Error('expected preparation')
		expect(await m.executePrepared(result.prepared, context())).toMatchObject({
			success: false,
			error: expect.stringMatching(/changed after its input was reviewed/),
		})
		expect(execute).not.toHaveBeenCalled()
	})

	it('retains schema failures while rejecting non-JSON final output without misclassifying it', async () => {
		const invalid = manager(
			z.object({ value: z.string() }).refine(async () => false, 'async refusal'),
		)
		expect(await invalid.manager.prepareExecutionAsync('prepared', { value: 'x' })).toMatchObject({
			success: false,
			inputFailure: 'schema_validation',
			result: { error: expect.stringContaining('async refusal') },
		})
		const unsafe = manager(z.object({}).transform(async () => new Date(0)))
		const refused = await unsafe.manager.prepareExecutionAsync('prepared', {})
		expect(refused).toMatchObject({
			success: false,
			result: { error: expect.stringMatching(/plain JSON object/) },
		})
		expect(refused).not.toHaveProperty('inputFailure')
		expect(unsafe.execute).not.toHaveBeenCalled()
	})

	it('preserves Date normalization and the existing synchronous return contract', async () => {
		const normalize = vi.fn((value: Date) => ({ instant: value.toISOString() }))
		const f = manager(z.date().transform(normalize))
		const date = new Date(0)
		const sync = f.manager.prepareExecution('prepared', date)
		expect(sync).not.toBeInstanceOf(Promise)
		expect(sync).toMatchObject({
			success: true,
			prepared: { input: { instant: date.toISOString() } },
		})
		expect(await f.manager.prepareExecutionAsync('prepared', date)).toMatchObject(sync)
		expect(await f.manager.execute('prepared', date, context())).toMatchObject({ success: true })
		expect(normalize).toHaveBeenCalledTimes(3)
	})

	it('preserves array subclass normalization without parsing again for execution', async () => {
		class HostValues extends Array<string> {
			first() {
				return this[0]
			}
		}
		const validate = vi.fn((input: unknown) => input instanceof HostValues)
		const normalize = vi.fn(async (input: HostValues) => ({ value: input.first() }))
		const f = manager(z.custom<HostValues>(validate).transform(normalize))
		const raw = new HostValues('original')
		const result = await f.manager.prepareExecutionAsync('prepared', raw)
		expect(result).toMatchObject({ success: true, prepared: { input: { value: 'original' } } })
		if (!result.success) throw new Error('expected preparation')
		await f.manager.executePrepared(result.prepared, context())
		expect(validate).toHaveBeenCalledExactlyOnceWith(raw)
		expect(normalize).toHaveBeenCalledOnce()
		expect(f.execute.mock.calls[0]?.[0]).toEqual({ value: 'original' })
	})

	it('preserves host array metadata outside the index range during async normalization', async () => {
		const raw = ['ordinary-item']
		Object.defineProperty(raw, '4294967295', {
			value: 'host-array-metadata',
			enumerable: true,
			writable: true,
			configurable: true,
		})
		const normalize = vi.fn((input: Record<string, unknown>) => ({
			metadata: input['4294967295'] ?? null,
		}))
		const f = manager(z.any().transform(normalize))
		const sync = f.manager.prepareExecution('prepared', raw)
		const asyncResult = await f.manager.prepareExecutionAsync('prepared', raw)
		expect(sync).toMatchObject({
			success: true,
			prepared: { input: { metadata: 'host-array-metadata' } },
		})
		expect(asyncResult).toEqual(sync)
		if (!asyncResult.success) throw new Error('expected preparation')
		await f.manager.executePrepared(asyncResult.prepared, context())
		expect(normalize).toHaveBeenCalledTimes(2)
		expect(normalize.mock.calls[1]?.[0]).toBe(raw)
		expect(f.execute.mock.calls[0]?.[0]).toEqual({ metadata: 'host-array-metadata' })
	})

	it.each([
		['ordinary', 'ordinary'],
		['ordinary', 'null'],
		['null', 'ordinary'],
		['null', 'null'],
	] as const)(
		'preserves raw %s root and %s nested prototypes while canonicalizing prepared output',
		async (rootKind, nestedKind) => {
			const rootPrototype = rootKind === 'null' ? null : Object.prototype
			const nestedPrototype = nestedKind === 'null' ? null : Object.prototype
			const raw = Object.assign(Object.create(rootPrototype), {
				nested: [Object.assign(Object.create(nestedPrototype), { value: 'original' })],
			})
			const inputs: unknown[] = []
			const schema = z.any().superRefine((input, ctx) => {
				inputs.push(input)
				if (
					Object.getPrototypeOf(input) !== rootPrototype ||
					Object.getPrototypeOf(input.nested[0]) !== nestedPrototype
				) {
					ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'raw prototype changed' })
				}
			})
			const f = manager(schema)
			const sync = f.manager.prepareExecution('prepared', raw)
			const asyncResult = await f.manager.prepareExecutionAsync('prepared', raw)
			expect(sync.success).toBe(true)
			expect(asyncResult).toEqual(sync)
			if (!asyncResult.success) throw new Error('expected preparation')
			expect(inputs).toHaveLength(2)
			expect(inputs[0]).toBe(raw)
			expect(inputs[1]).not.toBe(raw)
			expect((inputs[1] as typeof raw).nested[0]).not.toBe(raw.nested[0])
			const prepared = asyncResult.prepared.input as { nested: { value: string }[] }
			expect(Object.getPrototypeOf(prepared)).toBe(Object.prototype)
			expect(Object.getPrototypeOf(prepared.nested[0])).toBe(Object.prototype)
			expect(Object.isFrozen(prepared.nested[0])).toBe(true)
			await f.manager.executePrepared(asyncResult.prepared, context())
			expect(f.execute.mock.calls[0]?.[0]).toEqual({ nested: [{ value: 'original' }] })
		},
	)

	it('keeps a host schema implementing only safeParse compatible', async () => {
		const safeParse = vi.fn(() => ({
			success: false as const,
			error: { issues: [{ path: [], message: 'nope' }] },
		}))
		const schema = { safeParse } as unknown as ToolDefinition['inputSchema']
		const f = manager(schema)
		expect(await f.manager.execute('prepared', {}, context())).toMatchObject({
			success: false,
			error: expect.stringContaining('Could not introspect required parameters'),
		})
		expect(safeParse).toHaveBeenCalledOnce()
		expect(f.execute).not.toHaveBeenCalled()
	})
})
