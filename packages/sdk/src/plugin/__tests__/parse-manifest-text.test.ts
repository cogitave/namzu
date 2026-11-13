import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertEnableable, loadPluginManifest, parsePluginManifestText } from '../loader.js'

const good = JSON.stringify({ name: 'ledger', version: '1.0.0', description: 'Ledger review' })

describe('parsePluginManifestText', () => {
	it('returns the manifest for valid text', () => {
		expect(parsePluginManifestText(good)).toMatchObject({ name: 'ledger', version: '1.0.0' })
	})

	it('throws a SyntaxError for text that is not JSON, and an issue list for a bad manifest', () => {
		expect(() => parsePluginManifestText('{ oops')).toThrow(SyntaxError)
		try {
			parsePluginManifestText('{"name":"Bad Name","version":"1"}')
			expect.unreachable()
		} catch (error) {
			const issues = (error as { issues: { path: unknown[] }[] }).issues
			expect(issues.map((issue) => issue.path[0]).sort()).toEqual(['description', 'name'])
		}
	})

	it('is the first two steps of loadPluginManifest, so the same text is refused alike', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-manifest-text-'))
		await mkdir(root, { recursive: true })
		const text = '{"name":"ledger","version":"1.0.0","description":"d","connectors":["crm"]}'
		await writeFile(join(root, 'plugin.json'), text)
		const manifest = parsePluginManifestText(text)
		expect(() => assertEnableable(manifest, { skillsSupported: true })).toThrow(/connectors/)
		await expect(loadPluginManifest(root, { skillsSupported: true })).rejects.toThrow(/connectors/)
	})

	describe('the forms of `hooks` a plugin written for the common hook contract uses', () => {
		const base = { name: 'demo', version: '1.0.0', description: 'Demo' }
		const events = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] }

		it('reads a text as one hooks file', () => {
			const manifest = parsePluginManifestText(
				JSON.stringify({ ...base, hooks: './hooks/hooks.json' }),
			)
			expect(manifest.hooks).toEqual(['./hooks/hooks.json'])
		})

		it('reads an inline events object as hookEntries', () => {
			const manifest = parsePluginManifestText(JSON.stringify({ ...base, hooks: events }))
			expect(manifest.hooks).toBeUndefined()
			expect(manifest.hookEntries).toEqual(events)
		})

		it('does not drop one of an inline object and a hookEntries key', () => {
			expect(() =>
				parsePluginManifestText(JSON.stringify({ ...base, hooks: events, hookEntries: events })),
			).toThrow()
		})

		it('still refuses other values', () => {
			expect(() => parsePluginManifestText(JSON.stringify({ ...base, hooks: 3 }))).toThrow()
		})
	})
})
