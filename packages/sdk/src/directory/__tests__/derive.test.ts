import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { deriveRunOptions } from '../derive.js'
import { loadDirectory } from '../load.js'

const provider = { id: 'mock', name: 'Mock' } as never

function project(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-derive-'))
	for (const [relative, body] of Object.entries(files)) {
		const full = join(root, relative)
		mkdirSync(join(full, '..'), { recursive: true })
		writeFileSync(full, body)
	}
	return root
}

const TOOL = (name: string) => `
export default {
  name: ${JSON.stringify(name)},
  description: 'a tool',
  inputSchema: { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) },
  execute: async () => ({ success: true, output: 'ok' }),
}
`

describe('turning a manifest into run options', () => {
	it('carries instructions, config and tools across', async () => {
		const root = project({
			'instructions.md': 'You are terse.',
			'agent.js': 'export default { model: "m", maxIterations: 3, streamIdleTimeoutMs: 4321 }',
			'tools/a.js': TOOL('a'),
		})
		const { manifest } = await loadDirectory(root)

		const options = deriveRunOptions(manifest, { provider, prompt: 'hi' })

		expect(options.model).toBe('m')
		expect(options.instructions).toBe('You are terse.')
		expect(options.maxIterations).toBe(3)
		expect(options.streamIdleTimeoutMs).toBe(4321)
		expect(options.tools?.has('a')).toBe(true)
	})

	it('points the working directory at the project, not the host', async () => {
		// Left unset this defaults to the host's cwd, which aims the file
		// tools' containment at the host's own source tree.
		const root = project({
			'instructions.md': 'hi',
			'agent.js': 'export default { model: "m" }',
		})
		const { manifest } = await loadDirectory(root)

		expect(deriveRunOptions(manifest, { provider, prompt: 'hi' }).workingDirectory).toBe(
			manifest.root,
		)
	})

	it('lets an explicit model win over agent.ts', async () => {
		const root = project({
			'instructions.md': 'hi',
			'agent.js': 'export default { model: "from-file" }',
		})
		const { manifest } = await loadDirectory(root)

		expect(deriveRunOptions(manifest, { provider, prompt: 'hi', model: 'explicit' }).model).toBe(
			'explicit',
		)
	})

	it('refuses when nothing names a model', async () => {
		const root = project({ 'instructions.md': 'hi' })
		const { manifest } = await loadDirectory(root)

		expect(() => deriveRunOptions(manifest, { provider, prompt: 'hi' })).toThrow(/No model/)
	})

	it('forwards a name only when agent.ts declared one', async () => {
		// A name guessed from a directory basename becomes the agent id in
		// traces, where two sibling projects both called `agent` merge into one
		// attribution bucket.
		const declared = project({
			'instructions.md': 'hi',
			'agent.js': 'export default { model: "m", name: "researcher" }',
		})
		const guessed = project({
			'instructions.md': 'hi',
			'agent.js': 'export default { model: "m" }',
		})

		const withName = deriveRunOptions((await loadDirectory(declared)).manifest, {
			provider,
			prompt: 'x',
		})
		const without = deriveRunOptions((await loadDirectory(guessed)).manifest, {
			provider,
			prompt: 'x',
		})

		expect(withName.name).toBe('researcher')
		expect(without.name).toBeUndefined()
	})

	it('refuses a manifest whose modules were never loaded', async () => {
		// `manifest.tools` is empty for a reason that has nothing to do with
		// the project. Running it would produce an agent with no capabilities
		// and no indication why.
		const root = project({
			'instructions.md': 'hi',
			'agent.js': 'export default { model: "m" }',
			'tools/a.js': TOOL('a'),
		})
		const { manifest } = await loadDirectory(root, { modules: 'skip' })

		expect(() => deriveRunOptions(manifest, { provider, prompt: 'hi' })).toThrow(/modules: "skip"/)
	})

	it('lets overrides win over everything', async () => {
		const root = project({
			'instructions.md': 'hi',
			'agent.js': 'export default { model: "m", maxIterations: 3 }',
		})
		const { manifest } = await loadDirectory(root)

		const options = deriveRunOptions(manifest, {
			provider,
			prompt: 'hi',
			overrides: { maxIterations: 99 },
		})

		expect(options.maxIterations).toBe(99)
	})
})
