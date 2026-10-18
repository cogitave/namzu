import { describe, expect, it } from 'vitest'

import { META, runScript } from './host.js'

// META is one line, so the script text after it starts on line 2.
const failure = async (body: string) => {
	const { result } = await runScript(`${META}${body}`)
	expect(result.status).toBe('failed')
	return result.error ?? ''
}

describe('where a script failed', () => {
	it('names the line, column and source text of a runtime TypeError', async () => {
		const error = await failure(
			['const fn = 1', '', 'await agent("first")', 'const out = fn(3)', 'return out'].join('\n'),
		)
		expect(error).toMatch(/^TypeError: not a function — line 5, column \d+: const out = fn\(3\)/)
	})

	it('maps a throw deep inside nested functions to the script line, not the prelude', async () => {
		const error = await failure(
			[
				'const nest = async () => {',
				'  const items = null',
				'  return items.length',
				'}',
				'await nest()',
			].join('\n'),
		)
		expect(error).toMatch(/^TypeError: .*null.* — line 4, column \d+: return items\.length/)
	})

	it('names the call line when the prelude is what threw (swapped pipeline arguments)', async () => {
		const error = await failure(
			['const items = ["a"]', 'const fn = (x) => x', 'const out = await pipeline(fn, items)'].join(
				'\n',
			),
		)
		expect(error).toMatch(
			/^TypeError: pipeline\(items, \.\.\.stages\): the first argument must be an array, got a function — line 4, column \d+: const out = await pipeline\(fn, items\)/,
		)
	})

	it('names the line of a parse error', async () => {
		const error = await failure(['const a = 1', 'const b = (;', 'return a'].join('\n'))
		expect(error).toMatch(/^SyntaxError: .* — line 3, column \d+: const b = \(;/)
	})

	it('keeps a location after the blanked meta statement spanning several lines', async () => {
		const script = [
			'export const meta = {',
			"  name: 't',",
			"  description: 'multi line meta',",
			'}',
			'const x = undefined',
			'x.y.z',
		].join('\n')
		const { result } = await runScript(script)
		expect(result.error).toMatch(/ — line 6, column \d+: x\.y\.z/)
	})

	it('says so when the interpreter gives no location', async () => {
		const error = await failure('throw "plain string"')
		expect(error).toContain('plain string')
		expect(error).toMatch(/no line number/)
	})

	it('reports how far the run got', async () => {
		let n = 0
		const { result } = await runScript(
			`${META}phase('Scan')
await agent('one')
await agent('two')
phase('Fix')
await agent('three')
const nope = 1
nope()`,
			{
				host: {
					...(await import('./host.js')).makeHost(),
					spawnAgent: async () => {
						n++
						return n === 2
							? { state: 'error', tokens: 1, toolCalls: 0, error: 'boom' }
							: { state: 'done', text: 'ok', tokens: 1, toolCalls: 0 }
					},
				},
			},
		)
		expect(result.error).toMatch(/3 agents started, 2 finished, 1 failed/)
		expect(result.error).toMatch(/Last phase: "Fix"/)
	})
})

describe('wrong argument shapes', () => {
	const message = async (call: string) => {
		const error = await failure(`try { await ${call} } catch (e) { throw new Error(e.message) }`)
		return error.split(' — ')[0]
	}

	it('pipeline given a function first', async () => {
		expect(await message('pipeline(() => 1, [1])')).toBe(
			'Error: pipeline(items, ...stages): the first argument must be an array, got a function',
		)
	})

	it('pipeline given a non-function stage', async () => {
		expect(await message('pipeline([1], "x")')).toBe(
			'Error: pipeline(items, ...stages): stage 1 must be a function, got a string',
		)
	})

	it('parallel given non-thunks', async () => {
		expect(await message('parallel([agent("a")])')).toMatch(
			/^Error: parallel\(thunks\): item 1 must be a function .*, got a promise/,
		)
	})

	it('parallel given a non-array', async () => {
		expect(await message('parallel(() => 1)')).toBe(
			'Error: parallel(thunks): the argument must be an array of functions, got a function',
		)
	})

	it('agent given a non-string prompt', async () => {
		expect(await message('agent(["a"])')).toBe(
			'Error: agent(prompt, options?): the prompt must be a non-empty string, got an array',
		)
	})
})
