import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineTool } from '../../../tools/defineTool.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolRegistry } from '../execute.js'
import { createToolPresenter, genericLabel } from '../presentation.js'

/**
 * Presentation was four free functions in one host, switching on a
 * lowercased tool NAME. `name === 'write'` and `name === 'edit'` got a
 * diff; everything else got a truncated string.
 *
 * So a tool that host had never heard of — an MCP server's, a plugin's —
 * could not get a diff no matter what it did, and every second host
 * started from the raw arguments and rebuilt the same switch. The tool
 * knows what it is doing; the host knows how its surface renders. Neither
 * knew the other's half.
 */

function spyLogger(): { log: Logger; warn: ReturnType<typeof vi.fn> } {
	const warn = vi.fn()
	const log = {
		debug: vi.fn(),
		info: vi.fn(),
		warn,
		error: vi.fn(),
		child: () => log,
	} as unknown as Logger
	return { log, warn }
}

function registryWith(...tools: ReturnType<typeof defineTool>[]): ToolRegistry {
	const registry = new ToolRegistry()
	for (const tool of tools) registry.register(tool)
	return registry
}

const remotePatch = defineTool({
	name: 'remote_patch',
	description: 'patches a record on a remote system',
	inputSchema: z.object({ before: z.string(), after: z.string() }),
	category: 'analysis',
	permissions: [],
	readOnly: false,
	destructive: false,
	concurrencySafe: false,
	// No path. A diff is not always a file, and a tool patching a remote
	// record has a before and an after and nothing a host could open.
	presentCall: (input) => ({ kind: 'diff', before: input.before, after: input.after }),
	execute: async () => ({ success: true, output: 'patched' }),
})

describe('a tool the host never heard of', () => {
	it('gets the view it asks for', async () => {
		// The whole point. `remote_patch` matches none of the names the host
		// switch knew, and under that switch could only ever have been a
		// truncated string.
		const presenter = createToolPresenter(registryWith(remotePatch))

		const view = presenter.presentCall('remote_patch', { before: 'a', after: 'b' })

		expect(view.kind).toBe('diff')
		expect(view).toMatchObject({ before: 'a', after: 'b' })
	})

	it('falls back to a generic label when it has no opinion', async () => {
		const plain = defineTool({
			name: 'plain',
			description: 'no presenter',
			inputSchema: z.object({ query: z.string() }),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: '' }),
		})
		const presenter = createToolPresenter(registryWith(plain))

		expect(presenter.presentCall('plain', { query: 'find me' })).toEqual({
			kind: 'generic',
			label: 'find me',
		})
	})

	it('falls back for a tool that is not registered at all', async () => {
		// A host renders events from a run it did not configure — a resumed
		// run, a peer's stream. An unknown name must produce a view, not an
		// exception, and it is the only path where `registry.get` misses.
		const presenter = createToolPresenter(new ToolRegistry())

		expect(presenter.presentCall('never_registered', { path: '/tmp/x' })).toEqual({
			kind: 'generic',
			label: '/tmp/x',
		})
	})
})

describe('a presenter that throws', () => {
	it('yields the generic view and warns once, naming the tool', async () => {
		// Host-supplied code inside a render path. A throw must not take down
		// a surface that was only drawing a line — the same trade a log sink
		// already makes — and it must not be silent either, or a presenter
		// that never works looks like one with no opinion.
		const broken = defineTool({
			name: 'broken_view',
			description: 'its presenter throws',
			inputSchema: z.object({ path: z.string() }),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			presentCall: () => {
				throw new Error('presenter exploded')
			},
			execute: async () => ({ success: true, output: '' }),
		})
		const { log, warn } = spyLogger()
		const presenter = createToolPresenter(registryWith(broken), log)

		const view = presenter.presentCall('broken_view', { path: '/tmp/x' })

		expect(view).toEqual({ kind: 'generic', label: '/tmp/x' })
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0]?.[1]).toMatchObject({ 'namzu.tool.name': 'broken_view' })
	})
})

describe('the generic label, field by field', () => {
	// The pick ORDER is load-bearing and was arrived at by use. A table,
	// because asserting one arm would let the others be reordered freely.
	it.each([
		[{ command: 'ls', path: '/p', description: 'd' }, 'ls'],
		[{ path: '/p', file_path: '/f', description: 'd' }, '/p'],
		[{ file_path: '/f', pattern: 'x', description: 'd' }, '/f'],
		[{ pattern: 'x', query: 'q', description: 'd' }, 'x'],
		[{ query: 'q', description: 'd' }, 'q'],
		[{ description: 'd' }, 'd'],
	])('picks in order: %o', (input, expected) => {
		expect(genericLabel(input)).toBe(expected)
	})

	it('takes a bare string as itself', () => {
		expect(genericLabel('just text')).toBe('just text')
	})

	it('falls through to JSON for an object none of the fields describe', () => {
		// The arm `description` was added LAST to reduce: a delegation tool
		// showing a blob of its own arguments while the model was made to
		// write a label nothing read.
		expect(genericLabel({ unknown: 1 })).toBe('{"unknown":1}')
	})

	it('truncates rather than letting one field own the surface', () => {
		const label = genericLabel({ command: 'x'.repeat(500) })

		expect(label.length).toBe(120)
		expect(label.endsWith('…')).toBe(true)
	})
})

describe('presenting a result', () => {
	it("falls back to the RESULT's text, not the input's label", async () => {
		// A caller asking how to show what came back, and getting a
		// description of what went in, is worse off than with a plain string.
		const presenter = createToolPresenter(registryWith(remotePatch))

		const view = presenter.presentResult(
			'remote_patch',
			{ before: 'a', after: 'b' },
			{ success: true, output: 'patched 3 records' },
		)

		expect(view).toEqual({ kind: 'terminal', output: 'patched 3 records' })
	})

	it('hands the fallback the WHOLE output, however long', async () => {
		// This used to truncate to 120 characters on one line, which reads
		// as a reasonable default and is not: a host renders a result across
		// many rows, decides for itself how many fit — that is a property of
		// its terminal, not of the tool — and cannot recover text the kernel
		// already threw away. A tool that wants the one-line form returns a
		// `generic` view itself.
		const presenter = createToolPresenter(registryWith(remotePatch))
		const long = Array.from({ length: 40 }, (_, i) => `line ${i} of output`).join('\n')

		const view = presenter.presentResult('remote_patch', {}, { success: true, output: long })

		expect(view).toEqual({ kind: 'terminal', output: long })
	})
})
