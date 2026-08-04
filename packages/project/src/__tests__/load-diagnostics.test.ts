import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadProject } from '../load.js'

/**
 * Three refusals this loader claimed to make and did not.
 *
 * Each is the same shape: a check that existed, read the wrong thing, and
 * therefore reported the wrong answer while looking correct in review. A
 * loader whose entire job is to say what is wrong with a directory has to be
 * held to the diagnostics it actually emits, not the ones its code appears to
 * emit.
 */

function project(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-diag-'))
	for (const [relative, body] of Object.entries(files)) {
		const full = join(root, relative)
		mkdirSync(join(full, '..'), { recursive: true })
		writeFileSync(full, body)
	}
	return root
}

describe('a tool that would crash later is refused now', () => {
	it('rejects a default export with no inputSchema', async () => {
		// `name` and `execute` alone used to pass. The object then registered
		// clean and died in `toLLMTools()` on `inputSchema._def` — a TypeError
		// naming neither this file nor this loader.
		const root = project({
			'tools/broken.js': `
export default {
  name: 'broken',
  description: 'no schema',
  execute: async () => ({ success: true }),
}
`,
		})

		const { manifest, diagnostics, ok } = await loadProject(root)

		expect(ok).toBe(false)
		expect(diagnostics.map((d) => d.code)).toContain('not_a_tool')
		expect(manifest.tools).toHaveLength(0)
	})

	it('still accepts a hand-written tool that satisfies the published type', async () => {
		// The required set and no more: demanding `defineTool`'s extras would
		// make this loader refuse an object the SDK's own type accepts.
		const root = project({
			'tools/fine.js': `
export default {
  name: 'fine',
  description: 'a tool',
  inputSchema: { parse: (v) => v },
  execute: async () => ({ success: true }),
}
`,
		})

		const { manifest, ok } = await loadProject(root)

		expect(ok).toBe(true)
		expect(manifest.tools).toHaveLength(1)
	})
})

describe('an import failure explains itself', () => {
	it('gives the extension hint for a module it cannot resolve', async () => {
		// The hint is chosen from Node's error CODE. It used to be matched
		// against the message, which never contains the code, so every hint in
		// the function was unreachable and every author got the bare error.
		const root = project({
			'tools/importer.js': `
import './nowhere-at-all.js'
export default { name: 'x', description: 'x', inputSchema: {}, execute: async () => ({}) }
`,
		})

		const { diagnostics } = await loadProject(root)

		const failed = diagnostics.find((d) => d.code === 'module_load_failed')
		expect(failed).toBeDefined()
		expect(failed?.cause).toContain('real extension')
	})
})

describe('agent.ts metadata is checked, not assumed', () => {
	it('refuses metadata values that are not strings', async () => {
		// Typed `Record<string, string>` and admitted on `typeof === 'object'`,
		// so the values were never looked at and the type was a promise this
		// loader did not keep.
		const root = project({
			'agent.js': 'export default { model: "m", metadata: { count: 1 } }',
		})

		const { diagnostics, ok } = await loadProject(root)

		expect(ok).toBe(false)
		expect(diagnostics.some((d) => d.code === 'invalid_config')).toBe(true)
	})

	it('refuses an array, which typeof calls an object', async () => {
		const root = project({
			'agent.js': 'export default { model: "m", metadata: ["a", "b"] }',
		})

		const { ok } = await loadProject(root)

		expect(ok).toBe(false)
	})

	it('accepts a metadata object of strings', async () => {
		const root = project({
			'agent.js': 'export default { model: "m", metadata: { team: "core" } }',
		})

		const { manifest, ok } = await loadProject(root)

		expect(ok).toBe(true)
		expect(manifest.config.metadata).toEqual({ team: 'core' })
	})
})
