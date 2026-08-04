import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadDirectory } from '../load.js'

/**
 * Every case builds a real directory and reads it. A fixture object standing
 * in for the filesystem would pass while the scan, the import and the
 * containment check all did the wrong thing — and the whole package is those
 * three things.
 *
 * `.js` is used for tool files rather than `.ts`. Node's type stripping is
 * real and the loader accepts both, but a test that depends on it would be
 * testing Node's version rather than this code.
 */

const CAN_SYMLINK = (() => {
	try {
		const probe = mkdtempSync(join(tmpdir(), 'namzu-proj-sym-'))
		symlinkSync(probe, join(probe, 'self'), 'dir')
		return true
	} catch {
		return false
	}
})()

function project(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-proj-'))
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

describe('reading a project directory', () => {
	it('loads instructions, config and tools', async () => {
		const root = project({
			'instructions.md': 'You are helpful.\n',
			'agent.js': 'export default { model: "m", temperature: 0.2 }',
			'tools/search.js': TOOL('search'),
		})

		const { manifest, ok, diagnostics } = await loadDirectory(root)

		expect(ok, JSON.stringify(diagnostics)).toBe(true)
		expect(manifest.instructions).toBe('You are helpful.')
		expect(manifest.config).toMatchObject({ model: 'm', temperature: 0.2 })
		expect(manifest.tools.map((t) => t.definition.name)).toEqual(['search'])
	})

	it('reports a broken tool instead of dropping it', async () => {
		const root = project({
			'instructions.md': 'hi',
			'tools/good.js': TOOL('good'),
			'tools/broken.js': 'this is not valid javascript !!!',
		})

		const { manifest, ok, diagnostics } = await loadDirectory(root)

		expect(ok).toBe(false)
		// The good one still loaded — one bad file does not lose the rest.
		expect(manifest.tools.map((t) => t.definition.name)).toEqual(['good'])
		const failure = diagnostics.find((d) => d.code === 'module_load_failed')
		expect(failure?.path).toContain('broken')
		expect(manifest.sources.find((s) => s.id === 'broken')?.outcome).toBe('failed')
	})

	it('refuses both files when two tools claim one name', async () => {
		const root = project({
			'instructions.md': 'hi',
			'tools/a.js': TOOL('search'),
			'tools/b.js': TOOL('search'),
		})

		const { manifest, ok, diagnostics } = await loadDirectory(root)

		expect(ok).toBe(false)
		expect(diagnostics.some((d) => d.code === 'duplicate_tool_name')).toBe(true)
		// Picking a winner silently is what hides the mistake.
		expect(manifest.tools).toHaveLength(1)
	})

	it('rejects a default export that is not a tool', async () => {
		const root = project({
			'instructions.md': 'hi',
			'tools/x.js': 'export default { hello: 1 }',
		})

		const { ok, diagnostics } = await loadDirectory(root)

		expect(ok).toBe(false)
		expect(diagnostics.some((d) => d.code === 'not_a_tool')).toBe(true)
	})

	it('warns rather than errors when instructions are absent', async () => {
		// `runAgent` treats instructions as optional; this package does not get
		// to overrule the kernel about what a valid agent is.
		const root = project({ 'tools/a.js': TOOL('a') })

		const { ok, diagnostics } = await loadDirectory(root)

		expect(ok).toBe(true)
		expect(diagnostics.find((d) => d.code === 'instructions_missing')?.severity).toBe('warning')
	})

	it('errors on an instructions file that says nothing', async () => {
		const root = project({ 'instructions.md': '   \n' })

		const { ok, diagnostics } = await loadDirectory(root)

		expect(ok).toBe(false)
		expect(diagnostics.find((d) => d.code === 'instructions_empty')?.severity).toBe('error')
	})

	it('reports a malformed config field by name', async () => {
		const root = project({
			'instructions.md': 'hi',
			'agent.js': 'export default { model: 42 }',
		})

		const { ok, diagnostics } = await loadDirectory(root)

		expect(ok).toBe(false)
		expect(diagnostics.find((d) => d.code === 'invalid_config')?.message).toContain('"model"')
	})

	it('ignores dot- and underscore-prefixed entries silently', async () => {
		const root = project({
			'instructions.md': 'hi',
			'tools/real.js': TOOL('real'),
			'tools/_helpers/util.js': 'export const x = 1',
			'tools/.hidden.js': TOOL('hidden'),
		})

		const { manifest, ok, diagnostics } = await loadDirectory(root)

		expect(ok).toBe(true)
		expect(manifest.tools.map((t) => t.definition.name)).toEqual(['real'])
		expect(diagnostics.some((d) => d.code === 'unscanned_directory')).toBe(false)
	})

	it('warns about a subdirectory it did not scan', async () => {
		const root = project({
			'instructions.md': 'hi',
			'tools/nested/deep.js': TOOL('deep'),
		})

		const { diagnostics } = await loadDirectory(root)

		expect(diagnostics.find((d) => d.code === 'unscanned_directory')?.message).toContain('nested')
	})

	it('reports a missing directory rather than throwing', async () => {
		const { ok, diagnostics } = await loadDirectory(join(tmpdir(), 'namzu-does-not-exist-xyz'))

		expect(ok).toBe(false)
		expect(diagnostics[0]?.code).toBe('root_missing')
	})

	it('throws only on programmer error', async () => {
		await expect(loadDirectory('' as string)).rejects.toThrow(TypeError)
	})
})

describe('modules: skip', () => {
	it('gives full structure without importing anything', async () => {
		// The proof is the side effect: a module that would throw on import is
		// listed, and nothing runs.
		const root = project({
			'instructions.md': 'You are helpful.',
			'agent.js': 'throw new Error("agent.js executed")',
			'tools/a.js': 'throw new Error("tool executed")',
		})

		const { manifest, ok } = await loadDirectory(root, { modules: 'skip' })

		expect(ok).toBe(true)
		expect(manifest.instructions).toBe('You are helpful.')
		expect(manifest.sources.map((s) => s.id).sort()).toEqual(['a', 'agent', 'instructions'])
		expect(
			manifest.sources
				.filter((s) => s.slot !== 'instructions')
				.every((s) => s.outcome === 'not_loaded'),
		).toBe(true)
		expect(manifest.tools).toHaveLength(0)
	})
})

describe('include is an allow-list', () => {
	it('scans only what was asked for', async () => {
		const root = project({ 'instructions.md': 'hi', 'tools/a.js': TOOL('a') })

		const { manifest } = await loadDirectory(root, { include: ['tools'] })

		expect(manifest.included).toEqual(['tools'])
		expect(manifest.instructions).toBe('')
		expect(manifest.tools).toHaveLength(1)
	})

	it('scans nothing when the list is empty', async () => {
		// An allow-list that admits everything when empty is the fail-open
		// shape this estate removed elsewhere.
		const root = project({ 'instructions.md': 'hi', 'tools/a.js': TOOL('a') })

		const { manifest } = await loadDirectory(root, {
			include: [] as unknown as ['tools'],
		})

		expect(manifest.sources).toHaveLength(0)
		expect(manifest.tools).toHaveLength(0)
	})
})

describe('symlinks are refused, not followed', () => {
	it.skipIf(!CAN_SYMLINK)('does not import a linked tool file', async () => {
		const outside = mkdtempSync(join(tmpdir(), 'namzu-outside-'))
		writeFileSync(join(outside, 'evil.js'), TOOL('evil'))
		const root = project({
			'instructions.md': 'hi',
			'tools/real.js': TOOL('real'),
		})
		symlinkSync(join(outside, 'evil.js'), join(root, 'tools', 'linked.js'), 'file')

		const { manifest, diagnostics } = await loadDirectory(root)

		// The file that would be imported is not the file that was listed.
		expect(manifest.tools.map((t) => t.definition.name)).toEqual(['real'])
		expect(diagnostics.some((d) => d.code === 'symlink_refused')).toBe(true)
	})
})
